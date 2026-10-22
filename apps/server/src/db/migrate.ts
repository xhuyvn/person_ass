import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "./open.js";
import { transaction } from "./open.js";

export type MigrationFile = {
  version: number;
  name: string;
  filename: string;
  path: string;
};

export type MigrationResult = {
  applied: number;
  version: number;
  appliedVersions: number[];
  skipped: number;
};

const FILE_PATTERN = /^(\d{4})_([A-Za-z0-9_-]+)\.sql$/;

/* ------------------------------------------------------------------ */
/* SQL safety guard (E5)                                               */
/* ------------------------------------------------------------------ */

/**
 * Remove SQL comments so a commented-out statement can never hide a
 * destructive statement (and, the other way round, a real statement can
 * never be smuggled in as a comment).
 *
 * String literals are preserved verbatim.
 */
export function stripSqlComments(sql: string): string {
  let out = "";
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i] as string;

    if (ch === "'") {
      // Copy the string literal (including the doubled '' escape) as is.
      out += ch;
      i += 1;
      while (i < sql.length) {
        const c = sql[i] as string;
        out += c;
        i += 1;
        if (c === "'") {
          if (sql[i] === "'") {
            out += sql[i];
            i += 1;
            continue;
          }
          break;
        }
      }
      continue;
    }

    if (ch === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i += 1;
      continue;
    }

    if (ch === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }

    out += ch;
    i += 1;
  }

  return out;
}

/** Split SQL into statements, ignoring separators inside string literals. */
function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i] as string;

    if (ch === "'") {
      current += ch;
      i += 1;
      while (i < sql.length) {
        const c = sql[i] as string;
        current += c;
        i += 1;
        if (c === "'") {
          if (sql[i] === "'") {
            current += sql[i];
            i += 1;
            continue;
          }
          break;
        }
      }
      continue;
    }

    if (ch === ";") {
      statements.push(current);
      current = "";
      i += 1;
      continue;
    }

    current += ch;
    i += 1;
  }

  statements.push(current);
  return statements;
}

/**
 * Reject a destructive statement before it is executed.
 *
 * Allowed: additive schema changes (CREATE ..., ALTER TABLE ... ADD COLUMN).
 * Rejected: DROP TABLE / DROP INDEX / DROP VIEW, TRUNCATE, DELETE FROM and
 * every ALTER TABLE that is not an ADD COLUMN.
 */
export function findDestructiveStatements(sql: string): string[] {
  const stripped = stripSqlComments(sql);
  const offenders: string[] = [];

  for (const raw of splitSqlStatements(stripped)) {
    const statement = raw.trim().replace(/\s+/g, " ");
    if (statement.length === 0) continue;

    const upper = statement.toUpperCase();

    if (
      upper.startsWith("DROP TABLE") ||
      upper.startsWith("DROP INDEX") ||
      upper.startsWith("DROP VIEW")
    ) {
      offenders.push(statement);
      continue;
    }

    if (upper.startsWith("TRUNCATE")) {
      offenders.push(statement);
      continue;
    }

    if (upper.startsWith("DELETE FROM")) {
      offenders.push(statement);
      continue;
    }

    if (upper.startsWith("ALTER TABLE")) {
      // Only an additive column addition is allowed.
      if (!/^ALTER\s+TABLE\s+\S+\s+ADD\s+/i.test(statement)) {
        offenders.push(statement);
      }
      continue;
    }
  }

  return offenders;
}

/**
 * Throw when the migration file contains a destructive statement.
 * The error names the file and the offending statement.
 */
export function assertNonDestructiveSql(sql: string, filename: string): void {
  const offenders = findDestructiveStatements(sql);
  if (offenders.length === 0) return;

  const list = offenders.map((s) => s.slice(0, 200)).join(" | ");
  throw new Error(
    `Destructive statement rejected in migration ${filename}: ${list}. Migrations must be additive only.`,
  );
}

/* ------------------------------------------------------------------ */
/* Migration listing                                                   */
/* ------------------------------------------------------------------ */

/**
 * List migration files in ascending version order.
 *
 * Throws when a *.sql file has an invalid name (it would be silently skipped
 * otherwise and the schema would drift) or when two files share a version.
 */
export function listMigrations(migrationsDir: string): MigrationFile[] {
  if (!fs.existsSync(migrationsDir)) return [];

  const entries = fs.readdirSync(migrationsDir);

  const invalid = entries
    .filter((f) => f.endsWith(".sql") && !FILE_PATTERN.test(f))
    .sort();
  if (invalid.length > 0) {
    throw new Error(
      `Invalid migration filename: ${invalid.join(", ")}. Expected NNNN_name.sql`,
    );
  }

  const files = entries.filter((f) => FILE_PATTERN.test(f)).sort();

  const migrations = files.map((filename) => {
    const match = FILE_PATTERN.exec(filename);
    if (!match) throw new Error(`Invalid migration filename: ${filename}`);
    return {
      version: Number.parseInt(match[1] as string, 10),
      name: match[2] as string,
      filename,
      path: path.join(migrationsDir, filename),
    };
  });

  const byVersion = new Map<number, string[]>();
  for (const migration of migrations) {
    const names = byVersion.get(migration.version) ?? [];
    names.push(migration.filename);
    byVersion.set(migration.version, names);
  }
  for (const [version, names] of byVersion) {
    if (names.length > 1) {
      throw new Error(
        `Duplicate migration version ${String(version).padStart(4, "0")}: ${names.join(", ")}`,
      );
    }
  }

  return migrations;
}

function ensureMigrationsTable(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  );`);
}

/** True when the sqlite error is the "table does not exist" case. */
function isMissingTableError(err: unknown): boolean {
  const message =
    err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return message.includes("no such table");
}

function selectAppliedVersions(db: Db): number[] {
  const rows = db.prepare("SELECT version FROM schema_migrations").all() as {
    version: number;
  }[];
  return rows.map((r) => Number(r.version)).sort((a, b) => a - b);
}

/**
 * Versions already applied to the database.
 *
 * READ-ONLY on an existing schema: the SELECT is attempted first and the
 * bookkeeping table is created only when it is genuinely missing. A health
 * probe must never write to the database.
 */
export function appliedVersions(db: Db): number[] {
  try {
    return selectAppliedVersions(db);
  } catch (err) {
    if (!isMissingTableError(err)) throw err;
    ensureMigrationsTable(db);
    return selectAppliedVersions(db);
  }
}

/**
 * Apply pending migrations in ascending order, each in its own transaction.
 * Idempotent: already-applied versions are never re-run.
 */
export function runMigrations(db: Db, migrationsDir: string): MigrationResult {
  ensureMigrationsTable(db);
  const files = listMigrations(migrationsDir);
  const already = new Set(appliedVersions(db));
  const appliedVersionsList: number[] = [];
  let skipped = 0;

  for (const file of files) {
    if (already.has(file.version)) {
      skipped += 1;
      continue;
    }
    const sql = fs.readFileSync(file.path, "utf8");
    // Guard BEFORE executing: a destructive statement must never reach the
    // user's database (docs/07: "không reset DB của user").
    assertNonDestructiveSql(sql, file.filename);
    transaction(db, () => {
      db.exec(sql);
      db.prepare(
        "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
      ).run(file.version, file.name, new Date().toISOString());
    });
    appliedVersionsList.push(file.version);
  }

  const all = appliedVersions(db);
  return {
    applied: appliedVersionsList.length,
    version: all.length > 0 ? (all[all.length - 1] as number) : 0,
    appliedVersions: appliedVersionsList,
    skipped,
  };
}

/**
 * Walk up from this module's directory until a directory containing a
 * `migrations` folder is found (repo root).
 */
export function findMigrationsDir(startDir?: string): string {
  let dir = startDir ?? path.dirname(fileURLToPath(import.meta.url));
  const root = path.parse(dir).root;
  for (;;) {
    const candidate = path.join(dir, "migrations");
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
    if (dir === root) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("Could not locate migrations directory");
}
