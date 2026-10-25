import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import sharp from "sharp";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { buildDefaultAllowedHosts, dataPaths, ensureDataDirs, loadConfig, type Config } from "../src/config.js";
import { closeDatabase, openDatabase, type Db } from "../src/db/open.js";
import { findMigrationsDir, runMigrations } from "../src/db/migrate.js";
import { purgeExpiredUploads, readDerivedImage } from "../src/storage/attachments.js";
import type { Logger } from "../src/logger.js";

const MIGRATIONS_DIR = findMigrationsDir();
const quiet: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => quiet,
};

const CAPTURED = "2026-10-21T08:00:00+07:00";
const T0 = Date.parse(CAPTURED);

type Harness = {
  app: FastifyInstance;
  db: Db;
  root: string;
  paths: ReturnType<typeof dataPaths>;
  setNow: (ms: number) => void;
  now: () => number;
};

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

async function setup(overrides: Partial<Config> = {}): Promise<Harness> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "personalass-m3-"));
  const base = loadConfig();
  const config: Config = {
    ...base,
    dataDir: path.join(root, "data"),
    APP_ORIGIN: "http://127.0.0.1:2311",
    appOrigins: ["http://127.0.0.1:2311"],
    HOST: "127.0.0.1",
    PORT: 2310,
    allowedHosts: [...buildDefaultAllowedHosts("127.0.0.1", 2310), "localhost:80"],
    ...overrides,
  };
  const paths = { ...dataPaths(config), dbFile: path.join(root, "db", "p.sqlite") };
  ensureDataDirs(paths);
  const db = openDatabase(paths.dbFile);
  runMigrations(db, MIGRATIONS_DIR);
  let now = T0;
  const app = await buildApp({ config, paths, db, migrationsDir: MIGRATIONS_DIR, logger: quiet, clock: () => new Date(now) });
  closers.push(async () => {
    await app.close();
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { app, db, root, paths, setNow: (ms) => (now = ms), now: () => now };
}

/* ---- synthetic images ---- */

const solid = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 3, background: "#3070c0" } });
const jpeg = (w = 64, h = 48) => solid(w, h).jpeg().toBuffer();
const png = (w = 64, h = 48) => solid(w, h).png().toBuffer();
const webp = (w = 64, h = 48) => solid(w, h).webp().toBuffer();

function multipart(parts: Array<{ name: string; filename?: string; type?: string; data: Buffer | string }>) {
  const boundary = `----t${randomUUID().replace(/-/g, "")}`;
  const chunks: Buffer[] = [];
  for (const p of parts) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"`;
    if (p.filename !== undefined) head += `; filename="${p.filename}"`;
    head += "\r\n";
    if (p.type) head += `Content-Type: ${p.type}\r\n`;
    chunks.push(Buffer.from(head + "\r\n"), Buffer.isBuffer(p.data) ? p.data : Buffer.from(p.data), Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

async function upload(h: Harness, data: Buffer, type: string, filename = "photo.png") {
  const m = multipart([{ name: "file", filename, type, data }]);
  const res = await h.app.inject({ method: "POST", url: "/api/v1/attachments", payload: m.payload, headers: m.headers });
  return { status: res.statusCode, body: res.json() as any, res };
}

async function postMemo(h: Harness, body: Record<string, unknown>) {
  const res = await h.app.inject({
    method: "POST",
    url: "/api/v1/memos",
    payload: { client_request_id: randomUUID(), captured_at: CAPTURED, ...body },
  });
  return { status: res.statusCode, body: res.json() as any };
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out;
}

describe("M3 T1: attachment upload", () => {
  it("accepts JPEG, PNG and WebP and returns a receipt", async () => {
    const h = await setup();
    for (const [make, type] of [
      [jpeg, "image/jpeg"],
      [png, "image/png"],
      [webp, "image/webp"],
    ] as const) {
      const data = await make();
      const r = await upload(h, data, type);
      expect(r.status).toBe(201);
      expect(r.body.mime).toBe(type);
      expect(r.body.bytes).toBe(data.length);
      expect(r.body.width).toBe(64);
      expect(r.body.height).toBe(48);
      expect(r.body.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(r.body.attachment_token.length).toBeGreaterThanOrEqual(32);
      expect(Date.parse(r.body.expires_at)).toBe(T0 + 24 * 60 * 60_000);
    }
    // Staging creates no memo and no job.
    expect((h.db.prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number }).n).toBe(0);
  });

  it("derived copy is a downscaled JPEG without EXIF, even when the original has EXIF", async () => {
    const h = await setup({ DERIVED_IMAGE_MAX_EDGE: 512 });
    const original = await solid(1600, 800)
      .jpeg()
      .withExif({ IFD0: { Copyright: "synthetic-secret", Software: "test" } })
      .toBuffer();
    expect((await sharp(original).metadata()).exif).toBeTruthy();
    const r = await upload(h, original, "image/jpeg", "exif.jpg");
    expect(r.status).toBe(201);
    const row = h.db.prepare("SELECT * FROM attachments WHERE id = ?").get(r.body.attachment_id) as any;
    const derived = readDerivedImage(h.paths, row);
    const meta = await sharp(derived).metadata();
    expect(meta.format).toBe("jpeg");
    expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(512);
    expect(meta.exif).toBeUndefined();
    expect(derived.includes(Buffer.from("synthetic-secret"))).toBe(false);
    // The original file is kept byte for byte.
    const kept = fs.readFileSync(path.join(h.paths.attachmentsOriginal, row.relative_path));
    expect(kept.equals(original)).toBe(true);
    expect(row.derived_width).toBe(meta.width);
  });

  it("applies EXIF orientation to the reported size", async () => {
    const h = await setup();
    const data = await solid(400, 200).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const r = await upload(h, data, "image/jpeg");
    expect(r.status).toBe(201);
    expect([r.body.width, r.body.height]).toEqual([200, 400]);
  });

  it("A29: rejects a text file declared as image/png and PNG bytes declared as image/jpeg", async () => {
    const h = await setup();
    const fake = await upload(h, Buffer.from("this is not an image at all"), "image/png");
    expect(fake.status).toBe(400);
    expect(fake.body.error.code).toBe("BAD_REQUEST");
    expect(fake.body.error.message).toMatch(/ảnh/i);
    const mismatch = await upload(h, await png(), "image/jpeg");
    expect(mismatch.status).toBe(400);
    const gif = await upload(h, Buffer.from("GIF89a....."), "image/gif");
    expect(gif.status).toBe(400);
    expect(listFiles(h.paths.attachmentsOriginal)).toEqual([]);
    expect(listFiles(h.paths.attachmentsDerived)).toEqual([]);
  });

  it("rejects a truncated image that has a valid header", async () => {
    const h = await setup();
    const data = await png(200, 200);
    const r = await upload(h, data.subarray(0, Math.floor(data.length / 2)), "image/png");
    expect(r.status).toBe(400);
    expect(listFiles(h.paths.attachmentsOriginal)).toEqual([]);
  });

  it("returns 413 above MAX_UPLOAD_BYTES", async () => {
    const h = await setup({ MAX_UPLOAD_BYTES: 20_000 });
    const big = await sharp({ create: { width: 400, height: 400, channels: 3, background: "#808080", noise: { type: "gaussian", mean: 128, sigma: 60 } } })
      .png()
      .toBuffer();
    expect(big.length).toBeGreaterThan(20_000);
    const r = await upload(h, big, "image/png");
    expect(r.status).toBe(413);
    expect(r.body.error.code).toBe("PAYLOAD_TOO_LARGE");
    expect(listFiles(h.paths.attachmentsOriginal)).toEqual([]);
  });

  it("rejects an image above MAX_IMAGE_PIXELS (decompression bomb) and leaves no files", async () => {
    const h = await setup({ MAX_IMAGE_PIXELS: 1_000_000 });
    const bomb = await png(2000, 1500); // 3 MP, tiny on disk
    expect(bomb.length).toBeLessThan(100_000);
    const r = await upload(h, bomb, "image/png");
    expect(r.status).toBe(400);
    expect(listFiles(h.paths.attachmentsOriginal)).toEqual([]);
    expect(listFiles(h.paths.attachmentsDerived)).toEqual([]);
    expect((h.db.prepare("SELECT COUNT(*) AS n FROM attachments").get() as { n: number }).n).toBe(0);
  });

  it("returns 400 when no file part is sent or the request is not multipart", async () => {
    const h = await setup();
    const m = multipart([{ name: "note", data: "hello" }]);
    const none = await h.app.inject({ method: "POST", url: "/api/v1/attachments", payload: m.payload, headers: m.headers });
    expect(none.statusCode).toBe(400);
    const json = await h.app.inject({ method: "POST", url: "/api/v1/attachments", payload: { a: 1 } });
    expect(json.statusCode).toBe(400);
  });

  it("keeps the Origin guard on uploads", async () => {
    const h = await setup();
    const m = multipart([{ name: "file", filename: "a.png", type: "image/png", data: await png() }]);
    const res = await h.app.inject({
      method: "POST",
      url: "/api/v1/attachments",
      payload: m.payload,
      headers: { ...m.headers, origin: "https://evil.example" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("stores a hostile file name under a generated UUID name inside DATA_DIR", async () => {
    const h = await setup();
    const r = await upload(h, await png(), "image/png", "../../evil.png");
    expect(r.status).toBe(201);
    const row = h.db.prepare("SELECT * FROM attachments WHERE id = ?").get(r.body.attachment_id) as any;
    expect(row.relative_path).toBe(`${r.body.attachment_id}.png`);
    expect(row.derived_path).toBe(`${r.body.attachment_id}.jpg`);
    expect(path.isAbsolute(row.relative_path)).toBe(false);
    expect(row.original_name.length).toBeGreaterThan(0);
    for (const f of listFiles(h.root)) expect(path.basename(f)).not.toBe("evil.png");
    const inData = listFiles(h.paths.dataDir).filter((f) => f.includes(`${path.sep}attachments${path.sep}`));
    expect(inData).toHaveLength(2);
    // The token itself is never stored.
    expect(JSON.stringify(row)).not.toContain(r.body.attachment_token);
  });
});

describe("M3 T1: memo binding and serving", () => {
  it("binds two images in order, input_kind mixed, queues one job, serves the original", async () => {
    const h = await setup();
    const a = await upload(h, await png(), "image/png");
    const b = await upload(h, await jpeg(), "image/jpeg", "b.jpg");
    const memo = await postMemo(h, { text: "Ghi chú kèm ảnh", attachment_tokens: [b.body.attachment_token, a.body.attachment_token] });
    expect(memo.status).toBe(201);
    expect(memo.body.state).toBe("queued");
    expect(memo.body.job_id).toBeTruthy();
    expect((h.db.prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number }).n).toBe(1);

    const detail = (await h.app.inject({ method: "GET", url: `/api/v1/memos/${memo.body.memo_id}` })).json() as any;
    expect(detail.revision.input_kind).toBe("mixed");
    expect(detail.attachments.map((x: any) => x.id)).toEqual([b.body.attachment_id, a.body.attachment_id]);
    expect(detail.attachments.map((x: any) => x.position)).toEqual([0, 1]);
    expect(detail.attachments[0].content_path).toBe(`/api/v1/attachments/${b.body.attachment_id}/content`);
    expect(detail.attachments[0].ocr).toBeNull();

    const audit = h.db.prepare("SELECT after_json FROM audit_events WHERE action = 'memo.create'").get() as any;
    const after = JSON.parse(audit.after_json);
    expect(after.attachment_count).toBe(2);
    expect(after.attachment_ids).toEqual([b.body.attachment_id, a.body.attachment_id]);

    const content = await h.app.inject({ method: "GET", url: detail.attachments[0].content_path });
    expect(content.statusCode).toBe(200);
    expect(content.rawPayload.equals(await jpeg())).toBe(true);
    expect(content.headers["content-type"]).toBe("image/jpeg");
    expect(content.headers["x-content-type-options"]).toBe("nosniff");
    expect(content.headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
    expect(content.headers["content-disposition"]).toBe(`inline; filename="${b.body.attachment_id}.jpg"`);
    expect(content.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
  });

  it("accepts an images-only memo and rejects empty text without images", async () => {
    const h = await setup();
    const a = await upload(h, await webp(), "image/webp");
    const ok = await postMemo(h, { text: "", attachment_tokens: [a.body.attachment_token] });
    expect(ok.status).toBe(201);
    const detail = (await h.app.inject({ method: "GET", url: `/api/v1/memos/${ok.body.memo_id}` })).json() as any;
    expect(detail.revision.input_kind).toBe("image");
    const empty = await postMemo(h, { text: "", attachment_tokens: [] });
    expect(empty.status).toBe(400);
  });

  it("does not serve staged, unknown or malformed attachment ids", async () => {
    const h = await setup();
    const a = await upload(h, await png(), "image/png");
    const staged = await h.app.inject({ method: "GET", url: `/api/v1/attachments/${a.body.attachment_id}/content` });
    expect(staged.statusCode).toBe(404);
    const unknown = await h.app.inject({ method: "GET", url: `/api/v1/attachments/${randomUUID()}/content` });
    expect(unknown.statusCode).toBe(404);
    for (const id of ["..%2F..%2Fetc%2Fpasswd", "not-a-uuid", "%2e%2e"]) {
      const res = await h.app.inject({ method: "GET", url: `/api/v1/attachments/${id}/content` });
      expect([400, 404]).toContain(res.statusCode);
    }
  });

  it("rejects a reused token with 422 and a field error", async () => {
    const h = await setup();
    const a = await upload(h, await png(), "image/png");
    expect((await postMemo(h, { text: "một", attachment_tokens: [a.body.attachment_token] })).status).toBe(201);
    const again = await postMemo(h, { text: "hai", attachment_tokens: [a.body.attachment_token] });
    expect(again.status).toBe(422);
    expect(again.body.error.field_errors["attachment_tokens.0"]).toBeTruthy();
    expect((h.db.prepare("SELECT COUNT(*) AS n FROM memos").get() as { n: number }).n).toBe(1);
  });

  it("rejects unknown tokens and, atomically, a memo where only the second token is bad", async () => {
    const h = await setup();
    const a = await upload(h, await png(), "image/png");
    const r = await postMemo(h, { text: "x", attachment_tokens: [a.body.attachment_token, "unknown-token-0123456789"] });
    expect(r.status).toBe(422);
    expect(r.body.error.field_errors["attachment_tokens.1"]).toBeTruthy();
    // Nothing was bound and no memo was stored.
    expect((h.db.prepare("SELECT COUNT(*) AS n FROM memos").get() as { n: number }).n).toBe(0);
    expect((h.db.prepare("SELECT COUNT(*) AS n FROM attachments WHERE memo_revision_id IS NOT NULL").get() as { n: number }).n).toBe(0);
  });

  it("rejects an expired token with 422", async () => {
    const h = await setup();
    const a = await upload(h, await png(), "image/png");
    h.setNow(T0 + 24 * 60 * 60_000 + 60_000);
    const r = await postMemo(h, { text: "x", attachment_tokens: [a.body.attachment_token] });
    expect(r.status).toBe(422);
    expect(r.body.error.field_errors["attachment_tokens.0"]).toBeTruthy();
  });

  it("A07: the same client_request_id twice yields one memo and binds once", async () => {
    const h = await setup();
    const a = await upload(h, await png(), "image/png");
    const body = { client_request_id: randomUUID(), text: "lặp", attachment_tokens: [a.body.attachment_token] };
    const first = await postMemo(h, body);
    const second = await postMemo(h, body);
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect((h.db.prepare("SELECT COUNT(*) AS n FROM memos").get() as { n: number }).n).toBe(1);
    expect((h.db.prepare("SELECT COUNT(*) AS n FROM attachments WHERE memo_revision_id IS NOT NULL").get() as { n: number }).n).toBe(1);
    expect((h.db.prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number }).n).toBe(1);
  });

  it("limits the number of images per memo", async () => {
    const h = await setup();
    const tokens = Array.from({ length: 11 }, (_, i) => `token-number-${String(i).padStart(4, "0")}-padding`);
    const over = await postMemo(h, { text: "x", attachment_tokens: tokens });
    expect(over.status).toBe(400);

    const small = await setup({ MAX_IMAGES_PER_MEMO: 2 });
    const ups = [];
    for (let i = 0; i < 3; i++) ups.push((await upload(small, await png(), "image/png")).body.attachment_token);
    const r = await postMemo(small, { text: "x", attachment_tokens: ups });
    expect(r.status).toBe(400);
    expect(r.body.error.field_errors.attachment_tokens).toBeTruthy();
  });

  it("purges only expired unbound uploads and their files", async () => {
    const h = await setup();
    const bound = await upload(h, await png(), "image/png");
    const stale = await upload(h, await jpeg(), "image/jpeg");
    await postMemo(h, { text: "giữ", attachment_tokens: [bound.body.attachment_token] });
    const ctx = { db: h.db, clock: () => new Date(h.now()) };
    expect(purgeExpiredUploads(ctx, h.paths)).toBe(0);
    h.setNow(T0 + 2 * 24 * 60 * 60_000);
    const fresh = await upload(h, await webp(), "image/webp");
    expect(purgeExpiredUploads(ctx, h.paths)).toBe(1);
    const ids = (h.db.prepare("SELECT id FROM attachments ORDER BY created_at").all() as Array<{ id: string }>).map((r) => r.id);
    expect(ids).toContain(bound.body.attachment_id);
    expect(ids).toContain(fresh.body.attachment_id);
    expect(ids).not.toContain(stale.body.attachment_id);
    const files = listFiles(h.paths.attachmentsOriginal).map((f) => path.basename(f));
    expect(files).toHaveLength(2);
    expect(files.some((f) => f.startsWith(stale.body.attachment_id))).toBe(false);
    expect(listFiles(h.paths.attachmentsDerived)).toHaveLength(2);
  });
});
