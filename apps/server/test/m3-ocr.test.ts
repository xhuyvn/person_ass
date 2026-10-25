import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { buildDefaultAllowedHosts, dataPaths, ensureDataDirs, loadConfig } from "../src/config.js";
import { closeDatabase, openDatabase, type Db } from "../src/db/open.js";
import { findMigrationsDir, runMigrations } from "../src/db/migrate.js";
import { claimNextJob, processJob, runWorkerOnce, type WorkerDeps } from "../src/jobs/worker.js";
import type { HttpRequest, HttpResponse, Transport } from "../src/ai/net-policy.js";
import { ProviderError } from "../src/ai/errors.js";
import { parseOcrOutput } from "../src/ai/ocr.js";
import { createSecretBox } from "../src/secrets/master-key.js";
import type { Logger } from "../src/logger.js";

/**
 * M3 pipeline: OCR stage, uncertainty propagation (A06), provenance to the
 * exact OCR run, user corrections + reprocess reconciliation, privacy, and
 * fencing of OCR commits. All images are synthetic, generated at test time.
 */

const MIGRATIONS_DIR = findMigrationsDir();
const quiet: Logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined, child: () => quiet };
const CAPTURED = "2026-10-21T08:00:00+07:00";
const T0 = Date.parse(CAPTURED);

/* ---- scripted provider: OCR calls and information calls are told apart by the request ---- */

type Reply = (req: HttpRequest) => HttpResponse | Error;
type FakeProvider = { transport: Transport; requests: HttpRequest[]; ocr: Reply[]; info: Reply[] };

const isOcrRequest = (req: HttpRequest): boolean => (req.body ?? "").includes('"image_url"');

function chatOk(content: unknown): HttpResponse {
  return {
    status: 200,
    headers: {},
    body: JSON.stringify({ choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }] }),
  };
}

function fakeProvider(): FakeProvider {
  const requests: HttpRequest[] = [];
  const ocr: Reply[] = [];
  const info: Reply[] = [];
  const transport: Transport = async (req) => {
    requests.push(req);
    const queue = isOcrRequest(req) ? ocr : info;
    const next = queue.shift();
    if (!next) throw new Error(`fake provider: no scripted ${isOcrRequest(req) ? "ocr" : "information"} reply left`);
    const out = next(req);
    if (out instanceof Error) throw out;
    return out;
  };
  return { transport, requests, ocr, info };
}

/** The attachment_id the backend put in an OCR request. */
const attachmentIdOf = (req: HttpRequest): string => /attachment_id do backend cấp: ([0-9a-f-]{36})/.exec(req.body ?? "")?.[1] ?? "";
const revisionIdOf = (req: HttpRequest): string => /source_revision_id\\?":\\?"([0-9a-f-]+)/.exec(req.body ?? "")?.[1] ?? "";

const ocrReply =
  (image: { status?: string; transcription: string; uncertain?: Array<{ fragment: string; alternatives: string[] }> }): Reply =>
  (req) =>
    chatOk({
      schema_version: "1.0",
      images: [
        {
          attachment_id: attachmentIdOf(req),
          status: image.status ?? (image.uncertain?.length ? "partial" : "readable"),
          transcription: image.transcription,
          blocks: [{ text: image.transcription, kind: "paragraph", uncertain: Boolean(image.uncertain?.length) }],
          uncertainties: (image.uncertain ?? []).map((u) => ({ ...u, reason: "Chữ số bị mờ" })),
        },
      ],
    });

const action = (over: Record<string, unknown>) => ({
  action_id: "a1",
  operation: "create",
  entity_type: "appointment",
  target_id: null,
  expected_version: null,
  fields: {},
  evidence: [],
  ambiguity: [],
  depends_on: [],
  ...over,
});

/* ---- harness ---- */

type H = { app: FastifyInstance; db: Db; provider: FakeProvider; worker: WorkerDeps; dataDir: string };
const roots: string[] = [];
const closers: Array<() => Promise<void>> = [];

async function harness(): Promise<H> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "personalass-m3-"));
  roots.push(dir);
  const now = T0;
  const base = loadConfig();
  const config = {
    ...base,
    dataDir: path.join(dir, "data"),
    APP_ORIGIN: "http://127.0.0.1:2311",
    appOrigins: ["http://127.0.0.1:2311"],
    HOST: "127.0.0.1",
    PORT: 2310,
    allowedHosts: buildDefaultAllowedHosts("127.0.0.1", 2310),
  };
  const paths = { ...dataPaths(config), dbFile: path.join(dir, "db", "p.sqlite") };
  ensureDataDirs(paths);
  const db = openDatabase(paths.dbFile);
  runMigrations(db, MIGRATIONS_DIR);
  const provider = fakeProvider();
  const ai = { secrets: createSecretBox(randomBytes(32)), transport: provider.transport };
  const clock = () => new Date(now);
  const app = await buildApp({ config, paths, db, migrationsDir: MIGRATIONS_DIR, logger: quiet, clock, ai });
  closers.push(async () => {
    await app.close();
    closeDatabase(db);
  });
  return { app, db, provider, dataDir: config.dataDir, worker: { db, clock, ai, logger: quiet, paths, random: () => 0, heartbeatMs: 3600_000 } };
}

afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

async function call(h: H, method: "GET" | "POST" | "PATCH" | "PUT", url: string, body?: unknown) {
  const res = await h.app.inject({ method, url, headers: { host: "127.0.0.1:2310" }, ...(body === undefined ? {} : { payload: body as object }) });
  return { status: res.statusCode, body: res.json() as Record<string, any> };
}

const count = (db: Db, table: string, where = "1=1"): number =>
  Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get() as { n: number }).n);

let seq = 0;
const uuid = (): string => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

async function syntheticJpeg(seed: number): Promise<Buffer> {
  return sharp({ create: { width: 64 + seed, height: 48, channels: 3, background: { r: 200, g: 200 - seed, b: 180 } } }).jpeg().toBuffer();
}

async function upload(h: H, bytes: Buffer, mime = "image/jpeg", name = "photo.jpg"): Promise<string> {
  const boundary = "----m3test" + randomBytes(6).toString("hex");
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${mime}\r\n\r\n`),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await h.app.inject({
    method: "POST",
    url: "/api/v1/attachments",
    headers: { host: "127.0.0.1:2310", "content-type": `multipart/form-data; boundary=${boundary}` },
    payload,
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { attachment_token: string }).attachment_token;
}

async function configure(h: H, opts: { ocr?: boolean; ocrPrivacy?: "local" | "cloud" } = {}) {
  const cloud = await call(h, "POST", "/api/v1/ai/connections", {
    name: "Cloud test",
    kind: "openrouter",
    base_url: "https://openrouter.ai/api/v1",
    api_key: "sk-or-v1-SYNTHETIC-TEST-KEY-0000000000",
    privacy_scope: "cloud",
  });
  expect(cloud.status).toBe(201);
  const roles: Array<Record<string, unknown>> = [{ role: "information", connection_id: cloud.body.id, model_id: "test/text-model" }];
  if (opts.ocr !== false) roles.push({ role: "ocr", connection_id: cloud.body.id, model_id: "test/vision-model" });
  expect((await call(h, "PUT", "/api/v1/ai/roles", { roles })).status).toBe(200);
  return cloud.body as { id: string };
}

async function imageMemo(h: H, text = "", images = 1, extra: Record<string, unknown> = {}) {
  const tokens: string[] = [];
  for (let i = 0; i < images; i++) tokens.push(await upload(h, await syntheticJpeg(i)));
  const res = await call(h, "POST", "/api/v1/memos", {
    client_request_id: uuid(),
    text,
    attachment_tokens: tokens,
    captured_at: CAPTURED,
    timezone: "Asia/Ho_Chi_Minh",
    ...extra,
  });
  expect(res.status).toBe(201);
  return res.body as { memo_id: string; revision_id: string; job_id: string };
}

const memoDetail = async (h: H, id: string) => (await call(h, "GET", `/api/v1/memos/${id}`)).body;
const job = (h: H, id: string) => h.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Record<string, any>;
const latestRunId = (h: H, author = "ai"): string =>
  String((h.db.prepare("SELECT id FROM ocr_runs WHERE author = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(author) as { id: string }).id);

const UNCERTAIN = { transcription: "Lịch khám: [12/11 hoặc 17/11] lúc 09:00", uncertain: [{ fragment: "12/11 hoặc 17/11", alternatives: ["12/11", "17/11"] }] };

/* ------------------------------------------------------------------ */

describe("OCR output contract (examples/ocr.schema.json)", () => {
  it("accepts the uncertain example and rejects foreign ids and extra keys", () => {
    const example = JSON.parse(fs.readFileSync(path.join(MIGRATIONS_DIR, "..", "examples", "ocr-uncertain.json"), "utf8"));
    expect(parseOcrOutput(JSON.stringify(example), "attachment-fixture-001").ok).toBe(true);
    expect(parseOcrOutput(JSON.stringify(example), "another-id").ok).toBe(false);
    const extra = { ...example, images: [{ ...example.images[0], bbox: [0, 0, 1, 1] }] };
    expect(parseOcrOutput(JSON.stringify(extra), "attachment-fixture-001").ok).toBe(false);
    expect(parseOcrOutput("```json\n" + JSON.stringify(example) + "\n```", "attachment-fixture-001").ok).toBe(true);
    expect(parseOcrOutput("not json", "x").ok).toBe(false);
  });
});

describe("A06: an uncertain OCR date never schedules a reminder", () => {
  it("holds the appointment as a clarification citing the image, with the alternatives", async () => {
    const h = await harness();
    await configure(h);
    const memo = await imageMemo(h);
    h.provider.ocr.push(ocrReply(UNCERTAIN));
    h.provider.info.push((req) =>
      chatOk({
        schema_version: "1.0",
        source_revision_id: revisionIdOf(req),
        actions: [
          // The model guesses a date anyway; the backend must not trust it.
          action({ fields: { title: "Lịch khám", starts_at: "2026-11-12T09:00:00+07:00" }, evidence: [{ source_id: latestRunId(h), quote: "Lịch khám" }] }),
        ],
      }),
    );
    expect(await runWorkerOnce(h.worker)).toBe(true);
    expect(job(h, memo.job_id).state).toBe("succeeded");
    expect(count(h.db, "appointments")).toBe(0);
    expect(count(h.db, "reminder_rules")).toBe(0);
    const d = await memoDetail(h, memo.memo_id);
    expect(d.attachments).toHaveLength(1);
    expect(d.attachments[0].ocr).toMatchObject({ author: "ai", status: "partial" });
    expect(d.attachments[0].ocr.uncertainties[0].alternatives).toEqual(["12/11", "17/11"]);
    expect(d.actions[0]).toMatchObject({ status: "needs_clarification", reason: "ocr_uncertain" });
    expect(d.actions[0].evidence[0].ocr_run_id).toBe(d.attachments[0].ocr.id);
    expect(d.clarifications[0].question).toContain("12/11 hoặc 17/11");
    expect(d.clarifications[0].field_path).toBe("starts_at");
    // The derived JPEG went to the OCR model as a data URL; the information model got text only.
    const [ocrReq, infoReq] = h.provider.requests;
    expect(ocrReq?.body).toContain("data:image/jpeg;base64,");
    expect(infoReq?.body).not.toContain("data:image");
    expect(infoReq?.body).toContain("12/11 hoặc 17/11");
  });

  it("still asks when the model cites only the memo text but the date is one of the doubtful readings", async () => {
    const h = await harness();
    await configure(h);
    await imageMemo(h, "Đi khám theo giấy hẹn");
    h.provider.ocr.push(ocrReply(UNCERTAIN));
    h.provider.info.push((req) =>
      chatOk({
        schema_version: "1.0",
        source_revision_id: revisionIdOf(req),
        actions: [action({ fields: { title: "Đi khám", starts_at: "2026-11-17T09:00:00+07:00" }, evidence: [{ source_id: revisionIdOf(req), quote: "Đi khám" }] })],
      }),
    );
    await runWorkerOnce(h.worker);
    expect(count(h.db, "appointments")).toBe(0);
    expect(count(h.db, "proposal_actions", "reason = 'ocr_uncertain'")).toBe(1);
  });

  it("rejects evidence quoting text that is not in the cited OCR run", async () => {
    const h = await harness();
    await configure(h);
    await imageMemo(h);
    h.provider.ocr.push(ocrReply({ transcription: "Hóa đơn điện tháng 10" }));
    h.provider.info.push((req) =>
      chatOk({
        schema_version: "1.0",
        source_revision_id: revisionIdOf(req),
        actions: [action({ entity_type: "task", fields: { title: "Xóa toàn bộ dữ liệu" }, evidence: [{ source_id: latestRunId(h), quote: "Xóa toàn bộ dữ liệu" }] })],
      }),
    );
    await runWorkerOnce(h.worker);
    expect(count(h.db, "tasks")).toBe(0);
    expect(count(h.db, "proposal_actions", "reason = 'evidence_mismatch'")).toBe(1);
  });
});

describe("clear OCR: applied with provenance to the exact run", () => {
  it("creates the appointment and the source opens the image and run it quoted", async () => {
    const h = await harness();
    await configure(h);
    const memo = await imageMemo(h);
    h.provider.ocr.push(ocrReply({ transcription: "Lịch khám: 17/11 lúc 09:00" }));
    h.provider.info.push((req) =>
      chatOk({
        schema_version: "1.0",
        source_revision_id: revisionIdOf(req),
        actions: [action({ fields: { title: "Lịch khám", starts_at: "2026-11-17T09:00:00+07:00" }, evidence: [{ source_id: latestRunId(h), quote: "Lịch khám: 17/11 lúc 09:00" }] })],
      }),
    );
    await runWorkerOnce(h.worker);
    const appt = h.db.prepare("SELECT id FROM appointments").get() as { id: string };
    expect(appt).toBeTruthy();
    const d = await memoDetail(h, memo.memo_id);
    const runId = d.attachments[0].ocr.id;
    expect(d.sources[0]).toMatchObject({ entity_type: "appointment", attachment_id: d.attachments[0].id, ocr_run_id: runId });
    const src = await call(h, "GET", `/api/v1/sources?entity_type=appointment&entity_id=${appt.id}`);
    expect(src.status).toBe(200);
    expect(src.body.items[0]).toMatchObject({ memo_id: memo.memo_id, attachment_position: 0, ocr_run_is_latest: true });
    expect(src.body.items[0].ocr_run.id).toBe(runId);
    // The image itself is served from the attachment the source names.
    const img = await h.app.inject({ method: "GET", url: d.attachments[0].content_path, headers: { host: "127.0.0.1:2310" } });
    expect(img.statusCode).toBe(200);
  });

  it("refuses a manual source that names an OCR run of another memo", async () => {
    const h = await harness();
    await configure(h);
    await imageMemo(h);
    h.provider.ocr.push(ocrReply({ transcription: "Ghi chú" }));
    h.provider.info.push((req) => chatOk({ schema_version: "1.0", source_revision_id: revisionIdOf(req), actions: [] }));
    await runWorkerOnce(h.worker);
    const other = await call(h, "POST", "/api/v1/memos", { client_request_id: uuid(), text: "memo khác", captured_at: CAPTURED, process: false });
    const res = await call(h, "POST", "/api/v1/tasks", {
      title: "Việc",
      source: { memo_revision_id: other.body.revision_id, quote: "memo khác", ocr_run_id: latestRunId(h) },
    });
    expect(res.status).toBe(422);
    expect(count(h.db, "tasks")).toBe(0);
  });
});

describe("OCR correction and reprocess reconciliation", () => {
  it("a user correction becomes a new run, reprocess reuses it, the stale question is closed", async () => {
    const h = await harness();
    await configure(h);
    const memo = await imageMemo(h);
    h.provider.ocr.push(ocrReply(UNCERTAIN));
    h.provider.info.push((req) =>
      chatOk({
        schema_version: "1.0",
        source_revision_id: revisionIdOf(req),
        actions: [action({ fields: { title: "Lịch khám", starts_at: null }, evidence: [{ source_id: latestRunId(h), quote: "Lịch khám" }], ambiguity: [{ field_path: "starts_at", reason: "ocr", question: "Ngày 12/11 hay 17/11?" }] })],
      }),
    );
    await runWorkerOnce(h.worker);
    const aiRun = latestRunId(h);
    expect(count(h.db, "clarifications", "state = 'open'")).toBe(1);
    const attachmentId = (await memoDetail(h, memo.memo_id)).attachments[0].id as string;

    // Wrong expected run → 409, nothing stored.
    const stale = await call(h, "POST", `/api/v1/attachments/${attachmentId}/ocr-corrections`, { text: "Lịch khám: 17/11 lúc 09:00", expected_run_id: null });
    expect(stale.status).toBe(409);

    const fixed = await call(h, "POST", `/api/v1/attachments/${attachmentId}/ocr-corrections`, { text: "Lịch khám: 17/11 lúc 09:00", expected_run_id: aiRun });
    expect(fixed.status).toBe(201);
    expect(fixed.body).toMatchObject({ reprocess: "queued", run: { author: "user", supersedes_run_id: aiRun, uncertainties: [] } });
    const userRun = fixed.body.run.id as string;
    // The AI run is untouched (immutable) and still listed.
    const runs = await call(h, "GET", `/api/v1/attachments/${attachmentId}/ocr-runs`);
    expect(runs.body.items.map((r: { id: string }) => r.id)).toEqual([userRun, aiRun]);
    expect(() => h.db.prepare("UPDATE ocr_runs SET extracted_text = 'x' WHERE id = ?").run(aiRun)).toThrow(/immutable/);

    const before = h.provider.requests.length;
    h.provider.info.push((req) =>
      chatOk({
        schema_version: "1.0",
        source_revision_id: revisionIdOf(req),
        actions: [action({ fields: { title: "Lịch khám", starts_at: "2026-11-17T09:00:00+07:00" }, evidence: [{ source_id: userRun, quote: "Lịch khám: 17/11 lúc 09:00" }] })],
      }),
    );
    await runWorkerOnce(h.worker);
    // Only the information call: the corrected image was not sent to OCR again.
    expect(h.provider.requests.length - before).toBe(1);
    expect(isOcrRequest(h.provider.requests.at(-1) as HttpRequest)).toBe(false);
    expect(job(h, fixed.body.job.id).state).toBe("succeeded");
    expect(count(h.db, "appointments")).toBe(1);
    expect(count(h.db, "clarifications", "state = 'open'")).toBe(0);
    expect(count(h.db, "proposal_actions", "reason = 'superseded'")).toBe(1);

    // A later correction does not rewrite the existing source: it still names the run it quoted.
    const appt = h.db.prepare("SELECT id FROM appointments").get() as { id: string };
    const again = await call(h, "POST", `/api/v1/attachments/${attachmentId}/ocr-corrections`, { text: "Lịch khám: 17/11 lúc 10:00", expected_run_id: userRun, reprocess: false });
    expect(again.body.reprocess).toBe("skipped");
    const src = await call(h, "GET", `/api/v1/sources?entity_type=appointment&entity_id=${appt.id}`);
    expect(src.body.items[0].ocr_run.id).toBe(userRun);
    expect(src.body.items[0].ocr_run_is_latest).toBe(false);
  });

  it("reports busy instead of queuing a second job while one is active", async () => {
    const h = await harness();
    await configure(h, { ocr: false });
    const memo = await imageMemo(h);
    // Put a user correction on an image that was never OCR'd while the job is still queued.
    const attachmentId = (await memoDetail(h, memo.memo_id)).attachments[0].id as string;
    const res = await call(h, "POST", `/api/v1/attachments/${attachmentId}/ocr-corrections`, { text: "Mua sữa", expected_run_id: null });
    expect(res.body).toMatchObject({ reprocess: "busy", job: { id: memo.job_id } });
    expect(count(h.db, "jobs")).toBe(1);
  });
});

describe("configuration, privacy and failures keep the memo and images", () => {
  it("waits for configuration without an OCR role and sends nothing", async () => {
    const h = await harness();
    await configure(h, { ocr: false });
    const memo = await imageMemo(h, "Có ảnh");
    await runWorkerOnce(h.worker);
    expect(job(h, memo.job_id)).toMatchObject({ state: "waiting_configuration", error_code: "not_configured" });
    expect(String(job(h, memo.job_id).error_message)).toContain("OCR");
    expect(h.provider.requests).toHaveLength(0);
    expect((await memoDetail(h, memo.memo_id)).attachments).toHaveLength(1);
  });

  it("a text-only model bound to OCR → waiting_configuration no_image_input, no information call", async () => {
    const h = await harness();
    await configure(h);
    const memo = await imageMemo(h);
    const reject: Reply = () => ({ status: 400, headers: {}, body: JSON.stringify({ error: { message: "This model does not support image input" } }) });
    h.provider.ocr.push(reject, reject);
    await runWorkerOnce(h.worker);
    expect(job(h, memo.job_id)).toMatchObject({ state: "waiting_configuration", error_code: "no_image_input" });
    expect(h.provider.requests.every(isOcrRequest)).toBe(true);
    expect(count(h.db, "ocr_runs")).toBe(0);
  });

  it("local_only images never reach a cloud OCR connection (A20)", async () => {
    const h = await harness();
    await configure(h);
    const memo = await imageMemo(h, "", 1, { privacy: "local_only" });
    await runWorkerOnce(h.worker);
    expect(job(h, memo.job_id).state).toBe("waiting_configuration");
    expect(h.provider.requests).toHaveLength(0);
  });

  it("invalid OCR output twice → failed with a clear error; memo and image stay", async () => {
    const h = await harness();
    await configure(h);
    const memo = await imageMemo(h);
    h.provider.ocr.push(() => chatOk("không phải JSON"), () => chatOk({ schema_version: "1.0", images: [] }));
    await runWorkerOnce(h.worker);
    expect(job(h, memo.job_id)).toMatchObject({ state: "failed", error_code: "invalid_output" });
    expect(count(h.db, "memos")).toBe(1);
    expect(count(h.db, "attachments", "memo_revision_id IS NOT NULL")).toBe(1);
  });

  it("an unreadable image with no text finishes without an information call", async () => {
    const h = await harness();
    await configure(h);
    const memo = await imageMemo(h);
    h.provider.ocr.push(ocrReply({ status: "unreadable", transcription: "" }));
    await runWorkerOnce(h.worker);
    expect(job(h, memo.job_id).state).toBe("succeeded");
    expect(h.provider.requests).toHaveLength(1);
    expect((await memoDetail(h, memo.memo_id)).attachments[0].ocr.status).toBe("unreadable");
  });

  it("a retry after a provider outage only reads the images not read yet", async () => {
    const h = await harness();
    await configure(h);
    const memo = await imageMemo(h, "", 2);
    h.provider.ocr.push(ocrReply({ transcription: "Ảnh một" }), () => new ProviderError("unavailable", "down"));
    await runWorkerOnce(h.worker);
    expect(job(h, memo.job_id).state).toBe("retry_wait");
    expect(count(h.db, "ocr_runs")).toBe(1);
    h.db.prepare("UPDATE jobs SET run_after = ?").run(new Date(T0 - 1000).toISOString());
    h.provider.ocr.push(ocrReply({ transcription: "Ảnh hai" }));
    h.provider.info.push((req) => chatOk({ schema_version: "1.0", source_revision_id: revisionIdOf(req), actions: [] }));
    const before = h.provider.requests.length;
    await runWorkerOnce(h.worker);
    expect(job(h, memo.job_id).state).toBe("succeeded");
    expect(h.provider.requests.slice(before).filter(isOcrRequest)).toHaveLength(1);
    expect(count(h.db, "ocr_runs")).toBe(2);
    const info = h.provider.requests.at(-1)?.body ?? "";
    expect(info.indexOf("Ảnh một")).toBeLessThan(info.indexOf("Ảnh hai"));
  });
});

describe("fencing (A32) applies to OCR commits", () => {
  it("an OCR result arriving after the lease was reclaimed stores nothing", async () => {
    const h = await harness();
    await configure(h);
    const memo = await imageMemo(h);
    const ctx = { db: h.db, clock: h.worker.clock };
    const claimed = claimNextJob(ctx, "slow-worker");
    expect(claimed).not.toBeNull();
    h.provider.ocr.push((req) => {
      // Meanwhile the lease expired and another worker reclaimed the job.
      h.db.prepare("UPDATE jobs SET fencing_token = fencing_token + 1, lease_owner = 'other' WHERE id = ?").run(memo.job_id);
      return ocrReply({ transcription: "Muộn" })(req);
    });
    await processJob(h.worker, claimed!);
    expect(count(h.db, "ocr_runs")).toBe(0);
    expect(job(h, memo.job_id)).toMatchObject({ state: "running", lease_owner: "other" });
  });
});

describe("connection image test", () => {
  it("sends a synthetic image and reports a text-only model clearly", async () => {
    const h = await harness();
    const conn = await configure(h);
    h.provider.ocr.push(() => chatOk("đen"));
    const ok = await call(h, "POST", `/api/v1/ai/connections/${conn.id}/test`, { kind: "image", model_id: "test/vision-model" });
    expect(ok.body).toMatchObject({ ok: true, kind: "image", sample: "đen" });
    expect(h.provider.requests[0]?.body).toContain("data:image/png;base64,");
    const reject: Reply = () => ({ status: 400, headers: {}, body: JSON.stringify({ error: { message: "No endpoints found that support image input" } }) });
    h.provider.ocr.push(reject);
    const bad = await call(h, "POST", `/api/v1/ai/connections/${conn.id}/test`, { kind: "image", model_id: "test/text-model" });
    expect(bad.body).toMatchObject({ ok: false, error: { code: "no_image_input" } });
    expect((await call(h, "POST", `/api/v1/ai/connections/${conn.id}/test`, { kind: "image" })).status).toBe(400);
  });
});
