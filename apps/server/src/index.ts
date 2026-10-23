import { buildApp } from "./app.js";
import {
  assertServerModeRequirements,
  dataPaths,
  ensureDataDirs,
  loadConfig,
} from "./config.js";
import { findMigrationsDir, runMigrations } from "./db/migrate.js";
import { closeDatabase, openDatabase, type Db } from "./db/open.js";
import { startScheduler } from "./domain/scheduler.js";
import { createLogger } from "./logger.js";
import { appVersion } from "./version.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL);
  const paths = dataPaths(config);

  let db: Db | undefined;
  try {
    // Fail closed in server mode BEFORE anything is created or opened:
    // a missing master key must abort the startup with a structured log.
    assertServerModeRequirements(config);
    ensureDataDirs(paths);

    const migrationsDir = findMigrationsDir();

    db = openDatabase(paths.dbFile);
    const migration = runMigrations(db, migrationsDir);
    logger.info("migrations_applied", {
      applied: migration.applied,
      version: migration.version,
    });

    const clock = () => new Date();
    const app = await buildApp({ config, paths, db, migrationsDir, logger, clock });
    const stopScheduler = startScheduler({ db, clock }, logger);

    const shutdown = async (signal: string): Promise<void> => {
      logger.info("shutdown_started", { signal });
      stopScheduler();
      try {
        await app.close();
      } catch (err) {
        logger.error("shutdown_app_failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      try {
        if (db) closeDatabase(db);
      } catch (err) {
        logger.error("shutdown_db_failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      process.exit(0);
    };

    process.on("SIGINT", () => {
      void shutdown("SIGINT");
    });
    process.on("SIGTERM", () => {
      void shutdown("SIGTERM");
    });

    await app.listen({ host: config.HOST, port: config.PORT });
    logger.info("server_started", {
      host: config.HOST,
      port: config.PORT,
      app_mode: config.APP_MODE,
      tz: config.TZ,
      data_dir: paths.dataDir,
      version: appVersion(),
    });
  } catch (err) {
    logger.error("startup_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    if (db) closeDatabase(db);
    process.exit(1);
  }
}

void main();
