import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Db = DatabaseSync;

/**
 * Open (and create if needed) the SQLite database file with the pragmas
 * required by docs/02 (WAL, foreign keys, busy timeout).
 */
export function openDatabase(dbFile: string): Db {
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new DatabaseSync(dbFile);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA synchronous = NORMAL;");
  return db;
}

/** Run a function inside an immediate transaction. Rolls back on throw. */
export function transaction<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // rollback of an already-aborted transaction is not fatal here
    }
    throw err;
  }
}

export function closeDatabase(db: Db): void {
  try {
    db.close();
  } catch {
    // already closed
  }
}
