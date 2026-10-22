import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import type { HealthReady } from "@personalass/contracts";
import { healthLiveSchema, healthReadySchema } from "@personalass/contracts";
import type { Db } from "../db/open.js";
import { appliedVersions, listMigrations } from "../db/migrate.js";
import type { DataPaths } from "../config.js";
import { appVersion } from "../version.js";

export type HealthDeps = {
  db: Db;
  paths: DataPaths;
  migrationsDir: string;
};

/**
 * Short, sanitized description of a filesystem failure.
 * Only the error code and a short Vietnamese phrase are exposed: never the
 * absolute path and never the raw error message.
 */
function sanitizeFsError(err: unknown): string {
  const code =
    err !== null &&
    typeof err === "object" &&
    typeof (err as { code?: unknown }).code === "string"
      ? (err as { code: string }).code
      : "UNKNOWN";
  return `${code}: không ghi được vào thư mục dữ liệu`;
}

/**
 * Check that the data directory exists, is a directory and is writable.
 *
 * READ-ONLY: no probe file is created and no directory is created. A health
 * endpoint must not mutate the state it reports on.
 */
function probeDataDirWritable(dataDir: string): { ok: boolean; detail?: string } {
  try {
    const stat = fs.statSync(dataDir);
    if (!stat.isDirectory()) {
      return { ok: false, detail: "ENOTDIR: không ghi được vào thư mục dữ liệu" };
    }
    fs.accessSync(dataDir, fs.constants.W_OK);
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: sanitizeFsError(err) };
  }
}

export async function registerHealthRoutes(
  app: FastifyInstance,
  deps: HealthDeps,
): Promise<void> {
  app.get("/health/live", async (_req, reply) => {
    const body = {
      status: "ok" as const,
      service: "personalass-server" as const,
      version: appVersion(),
      uptime_s: Math.round(process.uptime() * 1000) / 1000,
      time: new Date().toISOString(),
    };
    reply.code(200);
    return healthLiveSchema.parse(body);
  });

  app.get("/health/ready", async (_req, reply) => {
    const database: HealthReady["checks"]["database"] = { ok: true, migrations_applied: 0 };
    try {
      const applied = appliedVersions(deps.db);
      const available = listMigrations(deps.migrationsDir);
      const missing = available.filter((m) => !applied.includes(m.version));
      database.migrations_applied = applied.length;
      if (missing.length > 0) {
        database.ok = false;
        database.detail = `pending migrations: ${missing.map((m) => m.filename).join(", ")}`;
      }
    } catch (err) {
      database.ok = false;
      database.migrations_applied = 0;
      database.detail = err instanceof Error ? err.message : String(err);
    }

    const data_dir = probeDataDirWritable(deps.paths.dataDir);

    const body: HealthReady = {
      status: database.ok && data_dir.ok ? "ok" : "degraded",
      checks: { database, data_dir },
      time: new Date().toISOString(),
    };

    const parsed = healthReadySchema.parse(body);
    reply.code(parsed.status === "ok" ? 200 : 503);
    return parsed;
  });
}
