import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { buildDefaultAllowedHosts, dataPaths, ensureDataDirs, loadConfig } from "../src/config.js";
import { closeDatabase, openDatabase, type Db } from "../src/db/open.js";
import { findMigrationsDir, runMigrations } from "../src/db/migrate.js";
import { runSchedulerTick } from "../src/domain/notifications.js";
import { localToUtc } from "../src/domain/time.js";
import type { Logger } from "../src/logger.js";

const MIGRATIONS_DIR = findMigrationsDir();
const quiet: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => quiet,
};

// docs/07: captured_at = 2026-10-21T08:00:00+07:00, Asia/Ho_Chi_Minh.
const CAPTURED = "2026-10-21T08:00:00+07:00";
const T0 = Date.parse(CAPTURED);

type H = { app: FastifyInstance; db: Db; setNow: (ms: number) => void; root: string };
const roots: string[] = [];
const closers: Array<() => Promise<void>> = [];

async function harness(root?: string, startMs = T0): Promise<H> {
  const dir = root ?? fs.mkdtempSync(path.join(os.tmpdir(), "personalass-m1-"));
  if (!root) roots.push(dir);
  let now = startMs;
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
  const app = await buildApp({
    config,
    paths,
    db,
    migrationsDir: MIGRATIONS_DIR,
    logger: quiet,
    clock: () => new Date(now),
  });
  closers.push(async () => {
    await app.close();
    closeDatabase(db);
  });
  return { app, db, setNow: (ms) => (now = ms), root: dir };
}

afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

async function call(h: H, method: "GET" | "POST" | "PATCH", url: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await h.app.inject({
    method,
    url,
    headers: { host: "127.0.0.1:2310", ...headers },
    ...(body === undefined ? {} : { payload: body as object }),
  });
  return { status: res.statusCode, body: res.json() as Record<string, any> };
}

const count = (db: Db, table: string): number =>
  Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);

describe("time", () => {
  it("converts Asia/Ho_Chi_Minh wall clock to UTC (no DST)", () => {
    expect(localToUtc("2026-10-22", "09:00", "Asia/Ho_Chi_Minh").toISOString()).toBe("2026-10-22T02:00:00.000Z");
  });
  it("handles a DST zone", () => {
    // New York is UTC-4 on 2026-07-01 and UTC-5 on 2026-12-01.
    expect(localToUtc("2026-07-01", "09:00", "America/New_York").toISOString()).toBe("2026-07-01T13:00:00.000Z");
    expect(localToUtc("2026-12-01", "09:00", "America/New_York").toISOString()).toBe("2026-12-01T14:00:00.000Z");
  });
});

describe("migration 0003", () => {
  it("is idempotent and keeps data", async () => {
    const h = await harness();
    await call(h, "POST", "/api/v1/notes", { title: "giữ lại" });
    const again = runMigrations(h.db, MIGRATIONS_DIR);
    expect(again.applied).toBe(0);
    expect(again.version).toBe(4);
    expect(count(h.db, "notes")).toBe(1);
  });
});

describe("tasks and default reminders", () => {
  it("A01: task without deadline creates no reminder", async () => {
    const h = await harness();
    const r = await call(h, "POST", "/api/v1/tasks", { title: "Mua nước giặt" });
    expect(r.status).toBe(201);
    expect(r.body.due_date).toBeNull();
    expect(count(h.db, "reminder_rules")).toBe(0);
    expect(count(h.db, "occurrences")).toBe(0);
  });

  it("date-only deadline reminds at 09:00 local the same day", async () => {
    const h = await harness();
    const r = await call(h, "POST", "/api/v1/tasks", { title: "Nộp báo cáo", due_date: "2026-10-22" });
    const rules = await call(h, "GET", `/api/v1/reminder-rules?entity_id=${r.body.id}`);
    expect(rules.body.items).toHaveLength(1);
    expect(rules.body.items[0]).toMatchObject({ anchor: "due_date", local_time: "09:00", next_at: "2026-10-22T02:00:00.000Z" });
  });

  it("rejects due_date together with due_at (400, field error)", async () => {
    const h = await harness();
    const r = await call(h, "POST", "/api/v1/tasks", { title: "x", due_date: "2026-10-22", due_at: "2026-10-22T02:00:00Z" });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("BAD_REQUEST");
    expect(r.body.error.field_errors.due_at).toBeTruthy();
  });

  it("PATCH requires expected_version and returns 409 on a stale version", async () => {
    const h = await harness();
    const t = (await call(h, "POST", "/api/v1/tasks", { title: "a" })).body;
    const missing = await call(h, "PATCH", `/api/v1/tasks/${t.id}`, { title: "b" });
    expect(missing.status).toBe(400);
    const ok = await call(h, "PATCH", `/api/v1/tasks/${t.id}`, { expected_version: 1, title: "b" });
    expect(ok.status).toBe(200);
    expect(ok.body.version).toBe(2);
    const stale = await call(h, "PATCH", `/api/v1/tasks/${t.id}`, { expected_version: 1, title: "c" });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("CONFLICT");
    expect((await call(h, "GET", `/api/v1/tasks/${t.id}`)).body.title).toBe("b");
  });

  it("unknown id is 404", async () => {
    const h = await harness();
    const r = await call(h, "GET", "/api/v1/tasks/6f1c1e0e-0000-4000-8000-000000000000");
    expect(r.status).toBe(404);
  });

  it("complete is idempotent, cancels the reminder; reopen restores it", async () => {
    const h = await harness();
    const t = (await call(h, "POST", "/api/v1/tasks", { title: "n", due_date: "2026-10-25" })).body;
    const done = await call(h, "POST", `/api/v1/tasks/${t.id}/complete`, { expected_version: 1 });
    expect(done.body.status).toBe("done");
    const retry = await call(h, "POST", `/api/v1/tasks/${t.id}/complete`, { expected_version: 1 });
    expect(retry.status).toBe(200);
    expect(retry.body.version).toBe(done.body.version);
    expect(count(h.db, "audit_events")).toBe(3 /* rule + create + complete */);
    const rule = (await call(h, "GET", `/api/v1/reminder-rules?entity_id=${t.id}`)).body.items[0];
    expect(rule.next_at).toBeNull();
    const reopened = await call(h, "POST", `/api/v1/tasks/${t.id}/reopen`, { expected_version: done.body.version });
    expect(reopened.body.status).toBe("open");
    const rule2 = (await call(h, "GET", `/api/v1/reminder-rules?entity_id=${t.id}`)).body.items[0];
    expect(rule2.next_at).toBe("2026-10-25T02:00:00.000Z");
  });

  it("Idempotency-Key: same body replays, different body is 409", async () => {
    const h = await harness();
    const key = { "idempotency-key": "key-0000-aaaa" };
    const a = await call(h, "POST", "/api/v1/tasks", { title: "once" }, key);
    const b = await call(h, "POST", "/api/v1/tasks", { title: "once" }, key);
    expect(b.status).toBe(201);
    expect(b.body.id).toBe(a.body.id);
    expect(count(h.db, "tasks")).toBe(1);
    const c = await call(h, "POST", "/api/v1/tasks", { title: "other" }, key);
    expect(c.status).toBe(409);
  });

  it("archive needs confirm and cancels future reminders", async () => {
    const h = await harness();
    const t = (await call(h, "POST", "/api/v1/tasks", { title: "z", due_date: "2026-10-30" })).body;
    const no = await call(h, "POST", `/api/v1/entities/task/${t.id}/archive`, { expected_version: 1 });
    expect(no.status).toBe(400);
    const ok = await call(h, "POST", `/api/v1/entities/task/${t.id}/archive`, { expected_version: 1, confirm: true });
    expect(ok.status).toBe(200);
    expect((await call(h, "GET", "/api/v1/tasks")).body.items).toHaveLength(0);
    expect(count(h.db, "occurrences WHERE status = 'pending'")).toBe(0);
  });
});

describe("appointments", () => {
  it("A02: tomorrow 09:00 meeting reminds 30 minutes before", async () => {
    const h = await harness();
    const a = await call(h, "POST", "/api/v1/appointments", {
      title: "Họp với Minh",
      starts_at: "2026-10-22T09:00:00+07:00",
      timezone: "Asia/Ho_Chi_Minh",
    });
    expect(a.status).toBe(201);
    expect(a.body.starts_at).toBe("2026-10-22T09:00:00+07:00");
    const rules = (await call(h, "GET", `/api/v1/reminder-rules?entity_id=${a.body.id}`)).body.items;
    expect(rules[0]).toMatchObject({ anchor: "starts_at", offset_minutes: -30, next_at: "2026-10-22T01:30:00.000Z" });
  });

  it("timed requires starts_at; all_day requires local_date", async () => {
    const h = await harness();
    expect((await call(h, "POST", "/api/v1/appointments", { title: "x" })).status).toBe(400);
    expect((await call(h, "POST", "/api/v1/appointments", { title: "x", all_day: true })).status).toBe(400);
    const ok = await call(h, "POST", "/api/v1/appointments", { title: "Khám", all_day: true, local_date: "2026-11-12" });
    expect(ok.status).toBe(201);
    expect(ok.body.starts_at).toBeNull();
    expect(ok.body.local_date).toBe("2026-11-12");
  });

  it("rescheduling cancels the old occurrence and creates a new revision (A11 shape)", async () => {
    const h = await harness();
    const a = (await call(h, "POST", "/api/v1/appointments", { title: "Họp", starts_at: "2026-10-22T09:00:00+07:00" })).body;
    const moved = await call(h, "PATCH", `/api/v1/appointments/${a.id}`, {
      expected_version: 1,
      starts_at: "2026-10-22T10:00:00+07:00",
    });
    expect(moved.status).toBe(200);
    const occ = h.db.prepare("SELECT status, schedule_revision, scheduled_at FROM occurrences ORDER BY schedule_revision").all() as any[];
    expect(occ.map((o) => o.status)).toEqual(["cancelled", "pending"]);
    expect(occ[1].scheduled_at).toBe("2026-10-22T02:30:00.000Z");
  });
});

describe("memos and sources", () => {
  const body = (id: string) => ({ client_request_id: id, text: "Mai 9h họp với Minh", captured_at: CAPTURED, timezone: "Asia/Ho_Chi_Minh" });

  it("A07: same client_request_id twice yields one memo", async () => {
    const h = await harness();
    const id = "0b5d5c1e-6f6a-4a52-9d7e-2b9d3c1f0a11";
    const a = await call(h, "POST", "/api/v1/memos", body(id));
    const b = await call(h, "POST", "/api/v1/memos", body(id));
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.body.memo_id).toBe(a.body.memo_id);
    // M2: one job per memo; the repeat returns the same job, never a second one.
    expect(b.body.job_id).toBe(a.body.job_id);
    expect(count(h.db, "jobs")).toBe(1);
    expect(count(h.db, "memos")).toBe(1);
    expect(count(h.db, "memo_revisions")).toBe(1);
  });

  it("task created from a memo carries a source link visible on the memo", async () => {
    const h = await harness();
    const m = (await call(h, "POST", "/api/v1/memos", body("1f0a4f3e-3b8e-4a1c-8d0e-6a7b8c9d0e12"))).body;
    const t = await call(h, "POST", "/api/v1/tasks", {
      title: "Chuẩn bị họp",
      source: { memo_revision_id: m.revision_id, quote: "họp với Minh" },
    });
    expect(t.status).toBe(201);
    const detail = (await call(h, "GET", `/api/v1/memos/${m.memo_id}`)).body;
    expect(detail.revision.raw_text).toBe("Mai 9h họp với Minh");
    expect(detail.sources).toEqual([
      { entity_type: "task", entity_id: t.body.id, memo_revision_id: m.revision_id, quote: "họp với Minh" },
    ]);
  });

  it("unknown source revision is 422 and creates nothing", async () => {
    const h = await harness();
    const r = await call(h, "POST", "/api/v1/tasks", {
      title: "x",
      source: { memo_revision_id: "6f1c1e0e-0000-4000-8000-000000000000" },
    });
    expect(r.status).toBe(422);
    expect(count(h.db, "tasks")).toBe(0);
  });

  it("A18: instruction-like text is stored verbatim, never executed", async () => {
    const h = await harness();
    const text = "DROP TABLE tasks; gọi http://evil.test/x";
    const m = (await call(h, "POST", "/api/v1/memos", { ...body("2a0a4f3e-3b8e-4a1c-8d0e-6a7b8c9d0e13"), text })).body;
    expect((await call(h, "GET", `/api/v1/memos/${m.memo_id}`)).body.revision.raw_text).toBe(text);
    expect(count(h.db, "tasks")).toBe(0);
  });
});

describe("scheduler and notifications", () => {
  async function dueTask(h: H) {
    // 2026-10-22 09:00 local = 02:00Z
    return (await call(h, "POST", "/api/v1/tasks", { title: "Nộp báo cáo", due_date: "2026-10-22" })).body;
  }
  const at = "2026-10-22T02:00:00.000Z";

  it("does not notify before the time, notifies once after, and never duplicates", async () => {
    const h = await harness();
    await dueTask(h);
    h.setNow(Date.parse(at) - 1000);
    expect(runSchedulerTick({ db: h.db, clock: () => new Date(Date.parse(at) - 1000) })).toEqual({ reminders: 0, missed: 0, digests: 0 });
    const later = () => new Date(Date.parse(at) + 20_000);
    expect(runSchedulerTick({ db: h.db, clock: later }).reminders).toBe(1);
    expect(runSchedulerTick({ db: h.db, clock: later }).reminders).toBe(0);
    expect(count(h.db, "notifications")).toBe(1);
  });

  it("A26/restart: notification written while 'tab closed' survives a restart and is listed", async () => {
    const h = await harness();
    await dueTask(h);
    runSchedulerTick({ db: h.db, clock: () => new Date(Date.parse(at) + 20_000) });
    await closers.pop()!();
    const h2 = await harness(h.root, Date.parse(at) + 3600_000);
    const list = await call(h2, "GET", "/api/v1/notifications?unread=true");
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({ kind: "reminder", title: "Nộp báo cáo", state: "delivered" });
  });

  it("A13: a 3-day outage becomes one digest, keeps the original deadline, no per-item spam", async () => {
    const h = await harness();
    const t = await dueTask(h);
    await call(h, "POST", "/api/v1/appointments", { title: "Khám", starts_at: "2026-10-22T14:00:00+07:00" });
    const back = () => new Date(Date.parse(at) + 3 * 86400_000);
    const r = runSchedulerTick({ db: h.db, clock: back });
    expect(r).toEqual({ reminders: 0, missed: 2, digests: 1 });
    const list = (await call(h, "GET", "/api/v1/notifications")).body.items;
    expect(list).toHaveLength(1);
    expect(list[0].kind).toBe("digest");
    expect(list[0].title).toBe("2 nhắc nhở bị lỡ");
    expect((await call(h, "GET", `/api/v1/tasks/${t.id}`)).body.due_date).toBe("2026-10-22");
    expect(count(h.db, "occurrences WHERE status = 'missed'")).toBe(2);
  });

  it("A31: changing the deadline before the tick only notifies for the new schedule", async () => {
    const h = await harness();
    const t = await dueTask(h);
    await call(h, "PATCH", `/api/v1/tasks/${t.id}`, { expected_version: 1, due_date: "2026-10-23" });
    const afterOld = () => new Date(Date.parse(at) + 20_000);
    expect(runSchedulerTick({ db: h.db, clock: afterOld }).reminders).toBe(0);
    const afterNew = () => new Date(Date.parse("2026-10-23T02:00:00Z") + 20_000);
    expect(runSchedulerTick({ db: h.db, clock: afterNew }).reminders).toBe(1);
  });

  it("completing a task before its reminder suppresses it", async () => {
    const h = await harness();
    const t = await dueTask(h);
    await call(h, "POST", `/api/v1/tasks/${t.id}/complete`, { expected_version: 1 });
    expect(runSchedulerTick({ db: h.db, clock: () => new Date(Date.parse(at) + 20_000) }).reminders).toBe(0);
  });

  it("ack is idempotent; snooze creates a one-off reminder and leaves the deadline alone", async () => {
    const h = await harness();
    const t = await dueTask(h);
    const nowFire = () => new Date(Date.parse(at) + 20_000);
    runSchedulerTick({ db: h.db, clock: nowFire });
    h.setNow(Date.parse(at) + 20_000);
    const n = (await call(h, "GET", "/api/v1/notifications")).body.items[0];
    const a1 = await call(h, "POST", `/api/v1/notifications/${n.id}/ack`);
    const a2 = await call(h, "POST", `/api/v1/notifications/${n.id}/ack`);
    expect(a1.body.state).toBe("acknowledged");
    expect(a2.body.acknowledged_at).toBe(a1.body.acknowledged_at);
    expect((await call(h, "GET", "/api/v1/notifications?unread=true")).body.items).toHaveLength(0);

    const sn = await call(h, "POST", `/api/v1/notifications/${n.id}/snooze`, { minutes: 30 });
    expect(sn.status).toBe(200);
    expect((await call(h, "GET", `/api/v1/tasks/${t.id}`)).body.due_date).toBe("2026-10-22");
    const later = () => new Date(Date.parse(at) + 20_000 + 31 * 60_000);
    expect(runSchedulerTick({ db: h.db, clock: later }).reminders).toBe(1);
  });
});

describe("openapi and error contract", () => {
  it("serves an OpenAPI 3.1 document covering the M1 routes", async () => {
    const h = await harness();
    const r = await call(h, "GET", "/api/v1/openapi.json");
    expect(r.status).toBe(200);
    expect(r.body.openapi).toBe("3.1.0");
    for (const p of ["/api/v1/memos", "/api/v1/tasks/{id}", "/api/v1/notifications/{id}/ack", "/api/v1/reminder-rules"]) {
      expect(Object.keys(r.body.paths)).toContain(p);
    }
    expect(r.body.paths["/api/v1/tasks"].post.requestBody.content["application/json"].schema.properties.title).toBeTruthy();
  });

  it("validation errors use the documented envelope", async () => {
    const h = await harness();
    const r = await call(h, "POST", "/api/v1/notes", { body: "no title" });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatchObject({ code: "BAD_REQUEST", retryable: false });
    expect(r.body.error.field_errors.title).toBeTruthy();
    expect(r.body.error.correlation_id).toBeTruthy();
  });
});
