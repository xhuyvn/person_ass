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
import { policyTransport } from "./ai/net-policy.js";
import type { AiDeps } from "./domain/ai-config.js";
import { startWorker } from "./jobs/worker.js";
import { purgeExpiredUploads } from "./storage/attachments.js";
import { loadMasterKey } from "./secrets/master-key.js";
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

    // Master key for provider API keys (docs/06 §2). Server mode fails closed;
    // in local mode the app keeps running and reports that keys cannot be used.
    let ai: AiDeps = { secrets: null, transport: policyTransport };
    try {
      const mk = loadMasterKey(config, paths);
      ai = { secrets: mk.box, transport: policyTransport };
      logger.info("master_key_loaded", {
        source: mk.source.kind,
        ...(mk.source.kind === "file" ? { created: mk.source.created } : {}),
      });
    } catch (err) {
      if (config.APP_MODE === "server") throw err;
      logger.error("master_key_unavailable", { error: err instanceof Error ? err.message : String(err) });
    }

    let wakeWorker: () => void = () => undefined;
    const app = await buildApp({
      config,
      paths,
      db,
      migrationsDir,
      logger,
      clock,
      ai,
      onJobQueued: () => wakeWorker(),
    });
    const stopScheduler = startScheduler({ db, clock }, logger);
    const purgeCtx = { db, clock };
    const purge = () => {
      try {
        const n = purgeExpiredUploads(purgeCtx, paths);
        if (n > 0) logger.info("expired_uploads_purged", { count: n });
      } catch (err) {
        logger.error("upload_purge_failed", { error: err instanceof Error ? err.message : String(err) });
      }
    };
    purge();
    const purgeTimer = setInterval(purge, 10 * 60_000);
    purgeTimer.unref();
    const worker = startWorker({ db, clock, ai, logger, paths });
    wakeWorker = worker.wake;

    const shutdown = async (signal: string): Promise<void> => {
      logger.info("shutdown_started", { signal });
      stopScheduler();
      clearInterval(purgeTimer);
      await worker.stop();
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
