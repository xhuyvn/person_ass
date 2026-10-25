import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, openDatabase, type Db } from "../src/db/open.js";
import {
  appliedVersions,
  findMigrationsDir,
  listMigrations,
  runMigrations,
} from "../src/db/migrate.js";

const MIGRATIONS_DIR = findMigrationsDir();

let tempDir: string;
let dbFile: string;
let db: Db;
let extraDirs: string[] = [];

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "personalass-migrate-"));
  dbFile = path.join(tempDir, "database", "personalass.sqlite");
  db = openDatabase(dbFile);
  extraDirs = [];
});

afterEach(() => {
  closeDatabase(db);
  fs.rmSync(tempDir, { recursive: true, force: true });
  for (const dir of extraDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function countRows(table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
    n: number;
  };
  return Number(row.n);
}

describe("runMigrations", () => {
  it("applies all migrations on a fresh database", () => {
    const result = runMigrations(db, MIGRATIONS_DIR);

    expect(result.applied).toBe(5);
    expect(result.version).toBe(5);
    expect(appliedVersions(db)).toEqual([1, 2, 3, 4, 5]);
  });

  it("is idempotent when run again", () => {
    runMigrations(db, MIGRATIONS_DIR);
    const second = runMigrations(db, MIGRATIONS_DIR);

    expect(second.applied).toBe(0);
    expect(second.skipped).toBe(5);
    expect(countRows("schema_migrations")).toBe(5);
  });

  it("preserves user data across re-runs", () => {
    runMigrations(db, MIGRATIONS_DIR);

    db.prepare(
      `INSERT INTO settings (id, owner_id, created_at, updated_at)
       VALUES (?, ?, ?, ?)`,
    ).run(
      "00000000-0000-4000-8000-000000000001",
      "owner-1",
      "2026-10-22T08:00:00.000Z",
      "2026-10-22T08:00:00.000Z",
    );

    runMigrations(db, MIGRATIONS_DIR);

    const row = db
      .prepare(`SELECT owner_id FROM settings WHERE id = ?`)
      .get("00000000-0000-4000-8000-000000000001") as
      | { owner_id: string }
      | undefined;

    expect(row).toBeDefined();
    expect(row?.owner_id).toBe("owner-1");
    expect(countRows("settings")).toBe(1);
  });

  it("records a parseable ISO timestamp in schema_migrations.applied_at", () => {
    runMigrations(db, MIGRATIONS_DIR);

    const rows = db
      .prepare("SELECT applied_at FROM schema_migrations")
      .all() as { applied_at: string }[];

    expect(rows).toHaveLength(5);
    for (const row of rows) {
      expect(row.applied_at).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      );
      expect(Number.isNaN(Date.parse(row.applied_at))).toBe(false);
    }
  });
});

describe("database pragmas", () => {
  it("uses WAL journal mode", () => {
    const row = db.prepare("PRAGMA journal_mode").get() as {
      journal_mode: string;
    };

    expect(row.journal_mode).toBe("wal");
  });

  it("enforces foreign keys", () => {
    const row = db.prepare("PRAGMA foreign_keys").get() as {
      foreign_keys: number;
    };

    expect(Number(row.foreign_keys)).toBe(1);
  });

  it("uses a 5000ms busy timeout", () => {
    const row = db.prepare("PRAGMA busy_timeout").get() as {
      timeout: number;
    };

    expect(Number(row.timeout)).toBe(5000);
  });
});

describe("schema", () => {
  beforeEach(() => {
    runMigrations(db, MIGRATIONS_DIR);
  });

  it("creates every expected table", () => {
    const expected = [
      "settings",
      "areas",
      "categories",
      "people",
      "projects",
      "memos",
      "memo_revisions",
      "tasks",
      "appointments",
      "reminder_rules",
      "source_links",
      "entity_links",
      "action_groups",
      "audit_events",
      "request_idempotency",
    ];

    const rows = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all() as { name: string }[];
    const tableNames = rows.map((r) => r.name);

    for (const name of expected) {
      expect(tableNames).toContain(name);
    }
  });

  it("rejects a task referencing a non-existent project", () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO tasks (id, owner_id, title, project_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "00000000-0000-4000-8000-000000000010",
          "owner-1",
          "Task lỗi FK",
          "00000000-0000-4000-8000-0000000000ff",
          "2026-10-22T08:00:00.000Z",
          "2026-10-22T08:00:00.000Z",
        ),
    ).toThrow();
  });

  it("enforces the task CHECK constraints", () => {
    const insert = (extra: {
      id: string;
      due_date?: string | null;
      due_at?: string | null;
      priority?: number;
      status?: string;
    }) =>
      db
        .prepare(
          `INSERT INTO tasks (id, owner_id, title, due_date, due_at, priority, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          extra.id,
          "owner-1",
          "Task kiểm tra",
          extra.due_date ?? null,
          extra.due_at ?? null,
          extra.priority ?? 0,
          extra.status ?? "open",
          "2026-10-22T08:00:00.000Z",
          "2026-10-22T08:00:00.000Z",
        );

    // Both due_date and due_at set -> mutually exclusive (docs/03 §3).
    expect(() =>
      insert({
        id: "00000000-0000-4000-8000-000000000011",
        due_date: "2026-10-22",
        due_at: "2026-10-22T09:00:00.000Z",
      }),
    ).toThrow();

    // due_date must be YYYY-MM-DD.
    expect(() =>
      insert({
        id: "00000000-0000-4000-8000-000000000012",
        due_date: "2026-1-1",
      }),
    ).toThrow();

    // priority must stay within 0..4.
    expect(() =>
      insert({
        id: "00000000-0000-4000-8000-000000000013",
        priority: 9,
      }),
    ).toThrow();

    // status must be one of the known enum values.
    expect(() =>
      insert({
        id: "00000000-0000-4000-8000-000000000014",
        status: "weird",
      }),
    ).toThrow();
  });

  it("enforces the appointment CHECK constraints", () => {
    const insert = (extra: {
      id: string;
      starts_at?: string | null;
      local_date?: string | null;
      all_day: number;
    }) =>
      db
        .prepare(
          `INSERT INTO appointments (id, owner_id, title, starts_at, local_date, all_day, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          extra.id,
          "owner-1",
          "Lịch kiểm tra",
          extra.starts_at ?? null,
          extra.local_date ?? null,
          extra.all_day,
          "2026-10-22T08:00:00.000Z",
          "2026-10-22T08:00:00.000Z",
        );

    // all_day without local_date.
    expect(() =>
      insert({ id: "00000000-0000-4000-8000-000000000020", all_day: 1 }),
    ).toThrow();

    // timed without starts_at.
    expect(() =>
      insert({ id: "00000000-0000-4000-8000-000000000021", all_day: 0 }),
    ).toThrow();

    // a valid all-day appointment must succeed.
    expect(() =>
      insert({
        id: "00000000-0000-4000-8000-000000000022",
        local_date: "2026-10-22",
        all_day: 1,
      }),
    ).not.toThrow();
  });

  it("enforces UNIQUE(memo_id, revision_no)", () => {
    db.prepare(
      `INSERT INTO memos (id, owner_id, created_at, updated_at)
       VALUES (?, ?, ?, ?)`,
    ).run(
      "00000000-0000-4000-8000-000000000030",
      "owner-1",
      "2026-10-22T08:00:00.000Z",
      "2026-10-22T08:00:00.000Z",
    );

    const insertRevision = (id: string, revisionNo: number) =>
      db
        .prepare(
          `INSERT INTO memo_revisions (id, memo_id, revision_no, raw_text, captured_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          "00000000-0000-4000-8000-000000000030",
          revisionNo,
          "nội dung",
          "2026-10-22T08:00:00.000Z",
          "2026-10-22T08:00:00.000Z",
          "2026-10-22T08:00:00.000Z",
        );

    expect(() =>
      insertRevision("00000000-0000-4000-8000-000000000031", 1),
    ).not.toThrow();
    expect(() =>
      insertRevision("00000000-0000-4000-8000-000000000032", 1),
    ).toThrow();
  });
});

describe("migration files", () => {
  it("never contain destructive statements", () => {
    const destructive = /\b(drop\s+table|delete\s+from|truncate)\b/i;
    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
      expect(`${file}: ${destructive.test(sql)}`).toBe(`${file}: false`);
    }
  });

  it("lists migrations in ascending order starting at version 1", () => {
    const migrations = listMigrations(MIGRATIONS_DIR);

    expect(migrations.length).toBeGreaterThan(0);
    expect(migrations[0]?.version).toBe(1);

    const versions = migrations.map((m) => m.version);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
  });
});

/* ------------------------------------------------------------------ */
/* Migration file hygiene: invalid names, duplicate versions and      */
/* destructive statements.                                             */
/* ------------------------------------------------------------------ */

describe("migration file names", () => {
  it("rejects a badly named .sql file instead of silently skipping it", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "personalass-badname-"));
    extraDirs.push(dir);

    fs.writeFileSync(
      path.join(dir, "0003_add column.sql"),
      "CREATE TABLE __bad (id TEXT);\n",
      "utf8",
    );

    let message = "";
    try {
      runMigrations(db, dir);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }

    expect(message).toContain("0003_add column.sql");
    expect(message.toLowerCase()).toContain("invalid migration filename");
  });

  it("rejects a .sql file with a non-padded version", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "personalass-badver-"));
    extraDirs.push(dir);

    fs.writeFileSync(
      path.join(dir, "3_x.sql"),
      "CREATE TABLE __bad (id TEXT);\n",
      "utf8",
    );

    expect(() => runMigrations(db, dir)).toThrow(/3_x\.sql/);
  });

  it("ignores non-.sql files", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "personalass-txt-"));
    extraDirs.push(dir);

    fs.writeFileSync(path.join(dir, "notes.txt"), "not a migration\n", "utf8");
    fs.writeFileSync(
      path.join(dir, "0001_ok.sql"),
      "CREATE TABLE __ok (id TEXT PRIMARY KEY);\n",
      "utf8",
    );

    const result = runMigrations(db, dir);

    expect(result.applied).toBe(1);
    expect(appliedVersions(db)).toEqual([1]);
  });
});

describe("duplicate migration versions", () => {
  it("rejects two files with the same version and names both files", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "personalass-dup-"));
    extraDirs.push(dir);

    fs.writeFileSync(
      path.join(dir, "0001_core.sql"),
      "CREATE TABLE __dup_a (id TEXT PRIMARY KEY);\n",
      "utf8",
    );
    fs.writeFileSync(
      path.join(dir, "0001_other.sql"),
      "CREATE TABLE __dup_b (id TEXT PRIMARY KEY);\n",
      "utf8",
    );

    let message = "";
    try {
      runMigrations(db, dir);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }

    expect(message).toContain("Duplicate migration version 0001");
    expect(message).toContain("0001_core.sql");
    expect(message).toContain("0001_other.sql");

    // Nothing of either file may have been created.
    const tables = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as { name: string }[]
    ).map((row) => row.name);
    expect(tables).not.toContain("__dup_a");
    expect(tables).not.toContain("__dup_b");
  });
});

describe("destructive migration guard", () => {
  it("rejects DROP TABLE and keeps the table and the version untouched", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "personalass-drop-"));
    extraDirs.push(dir);

    fs.writeFileSync(
      path.join(dir, "0001_create.sql"),
      "CREATE TABLE t_probe (id TEXT PRIMARY KEY);\n",
      "utf8",
    );
    fs.writeFileSync(
      path.join(dir, "0002_drop.sql"),
      "DROP TABLE IF EXISTS t_probe;\n",
      "utf8",
    );

    let message = "";
    try {
      runMigrations(db, dir);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }

    expect(message).toContain("0002_drop.sql");
    expect(message.toLowerCase()).toContain("destructive");

    // The table still exists and the rejected version was not recorded.
    const tables = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as { name: string }[]
    ).map((row) => row.name);
    expect(tables).toContain("t_probe");
    expect(appliedVersions(db)).toEqual([1]);
  });

  it("rejects DROP INDEX, DROP VIEW, TRUNCATE and DELETE FROM", () => {
    const cases = [
      "DROP INDEX idx_probe;",
      "DROP VIEW v_probe;",
      "TRUNCATE TABLE t_probe;",
      "DELETE FROM t_probe;",
    ];

    for (const statement of cases) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "personalass-destructive-"));
      extraDirs.push(dir);
      fs.writeFileSync(path.join(dir, "0001_bad.sql"), `${statement}\n`, "utf8");

      expect(() => runMigrations(db, dir)).toThrow(/destructive/i);
      closeDatabase(db);
      db = openDatabase(dbFile);
    }
  });

  it("rejects an ALTER TABLE that is not an ADD COLUMN", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "personalass-alter-"));
    extraDirs.push(dir);

    fs.writeFileSync(
      path.join(dir, "0001_create.sql"),
      "CREATE TABLE t_probe (id TEXT PRIMARY KEY);\n",
      "utf8",
    );
    fs.writeFileSync(
      path.join(dir, "0002_alter.sql"),
      "ALTER TABLE t_probe RENAME TO t_other;\n",
      "utf8",
    );

    let message = "";
    try {
      runMigrations(db, dir);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }

    expect(message).toContain("0002_alter.sql");
    expect(message.toLowerCase()).toContain("destructive");
    expect(appliedVersions(db)).toEqual([1]);
  });

  it("allows an additive ALTER TABLE ... ADD COLUMN", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "personalass-addcol-"));
    extraDirs.push(dir);

    fs.writeFileSync(
      path.join(dir, "0001_create.sql"),
      "CREATE TABLE t_probe (id TEXT PRIMARY KEY);\n",
      "utf8",
    );
    fs.writeFileSync(
      path.join(dir, "0002_add.sql"),
      "ALTER TABLE t_probe ADD COLUMN x TEXT;\n",
      "utf8",
    );

    const result = runMigrations(db, dir);

    expect(result.applied).toBe(2);
    expect(appliedVersions(db)).toEqual([1, 2]);

    const columns = db.prepare("PRAGMA table_info(t_probe)").all() as {
      name: string;
    }[];
    expect(columns.map((c) => c.name)).toContain("x");
  });

  it("allows a DROP statement that is only inside a comment", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "personalass-comment-"));
    extraDirs.push(dir);

    fs.writeFileSync(
      path.join(dir, "0001_create.sql"),
      "CREATE TABLE t_probe (id TEXT PRIMARY KEY);\n",
      "utf8",
    );
    fs.writeFileSync(
      path.join(dir, "0002_comment.sql"),
      "-- DROP TABLE IF EXISTS t_probe;\n/* DELETE FROM t_probe; */\nCREATE TABLE __kept (id TEXT PRIMARY KEY);\n",
      "utf8",
    );

    const result = runMigrations(db, dir);

    expect(result.applied).toBe(2);

    const tables = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as { name: string }[]
    ).map((row) => row.name);
    expect(tables).toContain("t_probe");
    expect(tables).toContain("__kept");
  });
});
