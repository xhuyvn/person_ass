import { dataPaths, ensureDataDirs, loadConfig } from "../config.js";
import { findMigrationsDir, runMigrations } from "./migrate.js";
import { closeDatabase, openDatabase } from "./open.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const paths = dataPaths(config);
  ensureDataDirs(paths);
  const migrationsDir = findMigrationsDir();
  const db = openDatabase(paths.dbFile);
  try {
    const result = runMigrations(db, migrationsDir);
    const summary = {
      applied: result.applied,
      version: result.version,
      db_file: paths.dbFile,
    };
    process.stdout.write(JSON.stringify(summary) + "\n");
  } finally {
    closeDatabase(db);
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(
    JSON.stringify({ error: "migrate_failed", message }) + "\n",
  );
  process.exitCode = 1;
});
