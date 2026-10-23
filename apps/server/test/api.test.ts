import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  apiErrorSchema,
  apiErrorStatusByCode,
  healthLiveSchema,
  healthReadySchema,
} from "@personalass/contracts";
import { buildApp } from "../src/app.js";
import {
  buildDefaultAllowedHosts,
  dataPaths,
  ensureDataDirs,
  loadConfig,
  type Config,
  type DataPaths,
} from "../src/config.js";
import { closeDatabase, openDatabase, type Db } from "../src/db/open.js";
import {
  appliedVersions,
  findMigrationsDir,
  runMigrations,
} from "../src/db/migrate.js";
import type { Logger } from "../src/logger.js";

const MIGRATIONS_DIR = findMigrationsDir();

/** Silent logger: keeps the test output free of expected error-path logs. */
const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
};

type Harness = {
  app: FastifyInstance;
  db: Db;
  paths: DataPaths;
  root: string;
};

let harness: Harness;
let roots: string[] = [];

function makeConfig(dataDir: string, overrides: Partial<Config> = {}): Config {
  const base = loadConfig();
  const merged = {
    ...base,
    dataDir,
    APP_ORIGIN: "http://127.0.0.1:8081",
    appOrigins: ["http://127.0.0.1:8081"],
    MAX_UPLOAD_BYTES: 10 * 1024 * 1024,
    // Pinned so the allowlist assertions do not depend on the shell env.
    HOST: "127.0.0.1",
    PORT: 4310,
    ...overrides,
  };
  return {
    ...merged,
    // The allowlist is derived from HOST/PORT so the tests are deterministic.
    // "localhost:80" is added explicitly: Fastify's inject() sends
    // "Host: localhost:80" (light-my-request default) which is NOT the
    // configured PORT, so it is allowlisted for the test app instead of
    // relying on the port-less "localhost" fallback.
    allowedHosts: [
      ...buildDefaultAllowedHosts(merged.HOST, merged.PORT),
      "localhost:80",
      ...(overrides.allowedHosts ?? []),
    ],
  };
}

async function createApp(
  options: {
    dataDir?: string;
    migrationsDir?: string;
    maxUploadBytes?: number;
    migrateFrom?: string;
    allowedHosts?: string[];
  } = {},
): Promise<Harness> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "personalass-api-"));
  roots.push(root);

  const dataDir = options.dataDir ?? path.join(root, "data");
  const config = makeConfig(
    dataDir,
    options.maxUploadBytes
      ? { MAX_UPLOAD_BYTES: options.maxUploadBytes }
      : {},
  );
  const configWithHosts = options.allowedHosts
    ? { ...config, allowedHosts: options.allowedHosts }
    : config;
  const paths: DataPaths = {
    ...dataPaths(configWithHosts),
    // Keep the database file outside dataDir so the data dir can be made
    // unwritable (it is then pointed at a plain file).
    dbFile: path.join(root, "db", "personalass.sqlite"),
  };

  const db = openDatabase(paths.dbFile);
  const migrationsDir = options.migrationsDir ?? MIGRATIONS_DIR;
  runMigrations(db, options.migrateFrom ?? MIGRATIONS_DIR);

  // The data dir normally exists (the server creates it at startup). The
  // readiness probe itself never creates anything.
  try {
    ensureDataDirs(paths);
  } catch {
    // The data dir may intentionally be unusable (a plain file).
  }

  const app = await buildApp({
    config: configWithHosts,
    paths,
    db,
    migrationsDir,
    logger: silentLogger,
  });

  // Test-only routes (never part of the production source tree).
  app.post("/__test/echo", async (request) => request.body);
  app.get("/__test/boom", async () => {
    throw new Error("boom detail");
  });
  app.get("/__test/unsupported-media", async () => {
    const error = new Error("unsupported media type") as Error & {
      statusCode: number;
    };
    error.statusCode = 415;
    throw error;
  });
  app.get("/__test/unavailable", async () => {
    const error = new Error("service unavailable") as Error & {
      statusCode: number;
    };
    error.statusCode = 503;
    throw error;
  });

  return { app, db, paths, root };
}

beforeEach(async () => {
  roots = [];
  harness = await createApp();
});

afterEach(async () => {
  await harness.app.close();
  closeDatabase(harness.db);
  for (const root of roots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("GET /health/live", () => {
  it("returns 200 with a valid live payload and a correlation id", async () => {
    const response = await harness.app.inject({
      method: "GET",
      url: "/health/live",
    });

    expect(response.statusCode).toBe(200);

    const body = healthLiveSchema.parse(response.json());
    expect(body.status).toBe("ok");
    expect(body.service).toBe("personalass-server");

    expect(response.headers["x-correlation-id"]).toBeTruthy();
    expect(String(response.headers["x-correlation-id"]).length).toBeGreaterThan(0);
  });
});

describe("GET /health/ready", () => {
  it("returns 200 when the database and data dir are healthy", async () => {
    const response = await harness.app.inject({
      method: "GET",
      url: "/health/ready",
    });

    expect(response.statusCode).toBe(200);

    const body = healthReadySchema.parse(response.json());
    expect(body.status).toBe("ok");
    expect(body.checks.database.ok).toBe(true);
    expect(body.checks.database.migrations_applied).toBe(3);
    expect(body.checks.data_dir.ok).toBe(true);
  });

  it("returns 503 degraded when a migration is pending", async () => {
    const pendingDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "personalass-pending-"),
    );
    roots.push(pendingDir);

    for (const file of fs.readdirSync(MIGRATIONS_DIR)) {
      if (!file.endsWith(".sql")) continue;
      fs.copyFileSync(
        path.join(MIGRATIONS_DIR, file),
        path.join(pendingDir, file),
      );
    }
    fs.writeFileSync(
      path.join(pendingDir, "0003_test_pending.sql"),
      "CREATE TABLE IF NOT EXISTS __test_pending (id TEXT PRIMARY KEY);\n",
      "utf8",
    );

    const pending = await createApp({ migrationsDir: pendingDir });
    const response = await pending.app.inject({
      method: "GET",
      url: "/health/ready",
    });

    expect(response.statusCode).toBe(503);

    const body = healthReadySchema.parse(response.json());
    expect(body.status).toBe("degraded");
    expect(body.checks.database.ok).toBe(false);
    expect(body.checks.database.detail).toContain("0003_test_pending.sql");

    await pending.app.close();
    closeDatabase(pending.db);
  });

  it("returns 503 degraded when the data dir is not writable", async () => {
    const unusable = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "personalass-unusable-")),
      "not-a-directory",
    );
    fs.writeFileSync(unusable, "this is a file, not a directory", "utf8");
    roots.push(path.dirname(unusable));

    const broken = await createApp({ dataDir: unusable });
    const response = await broken.app.inject({
      method: "GET",
      url: "/health/ready",
    });

    expect(response.statusCode).toBe(503);

    const body = healthReadySchema.parse(response.json());
    expect(body.status).toBe("degraded");
    expect(body.checks.data_dir.ok).toBe(false);
    // The detail must be sanitized: no path, no raw error message.
    expect(body.checks.data_dir.detail).toBeTruthy();
    expect(body.checks.data_dir.detail).not.toContain(unusable);
    expect(body.checks.data_dir.detail).not.toContain("not-a-directory");
    expect(body.checks.data_dir.detail).toMatch(/^[A-Z]+:/);

    await broken.app.close();
    closeDatabase(broken.db);
  });

  it("stays healthy across repeated readiness checks", async () => {
    for (let i = 0; i < 5; i += 1) {
      const response = await harness.app.inject({
        method: "GET",
        url: "/health/ready",
      });
      expect(response.statusCode).toBe(200);
    }
  });
});

describe("404 handling", () => {
  it("returns the error envelope for an unknown GET route", async () => {
    const response = await harness.app.inject({
      method: "GET",
      url: "/does-not-exist",
    });

    expect(response.statusCode).toBe(404);

    const raw = response.body;
    const parsed = apiErrorSchema.parse(JSON.parse(raw));
    expect(parsed.error.code).toBe("NOT_FOUND");
    expect(parsed.error.retryable).toBe(false);
    expect(parsed.error.correlation_id.length).toBeGreaterThan(0);

    expect(raw).not.toContain("stack");
    expect(raw).not.toContain("at Object.");
    expect(raw).not.toContain("node_modules");
  });

  it("returns the error envelope for an unknown POST route", async () => {
    const response = await harness.app.inject({
      method: "POST",
      url: "/does-not-exist",
      payload: { a: 1 },
    });

    expect(response.statusCode).toBe(404);

    const parsed = apiErrorSchema.parse(response.json());
    expect(parsed.error.code).toBe("NOT_FOUND");
    expect(parsed.error.retryable).toBe(false);
    expect(parsed.error.correlation_id.length).toBeGreaterThan(0);
  });
});

describe("request validation", () => {
  it("returns BAD_REQUEST for malformed JSON", async () => {
    const response = await harness.app.inject({
      method: "POST",
      url: "/__test/echo",
      headers: { "content-type": "application/json" },
      payload: "{ this is not json",
    });

    expect(response.statusCode).toBe(400);

    const parsed = apiErrorSchema.parse(response.json());
    expect(parsed.error.code).toBe("BAD_REQUEST");
    expect(parsed.error.retryable).toBe(false);
    expect(parsed.error.correlation_id.length).toBeGreaterThan(0);
  });

  it("returns PAYLOAD_TOO_LARGE when the body exceeds the limit", async () => {
    const limited = await createApp({ maxUploadBytes: 1024 });
    const response = await limited.app.inject({
      method: "POST",
      url: "/__test/echo",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ blob: "x".repeat(4096) }),
    });

    expect(response.statusCode).toBe(413);

    const parsed = apiErrorSchema.parse(response.json());
    expect(parsed.error.code).toBe("PAYLOAD_TOO_LARGE");

    await limited.app.close();
    closeDatabase(limited.db);
  });
});

describe("correlation id", () => {
  it("echoes a valid correlation id", async () => {
    const response = await harness.app.inject({
      method: "GET",
      url: "/does-not-exist",
      headers: { "x-correlation-id": "my_corr-1" },
    });

    expect(response.headers["x-correlation-id"]).toBe("my_corr-1");

    const parsed = apiErrorSchema.parse(response.json());
    expect(parsed.error.correlation_id).toBe("my_corr-1");
  });

  it("sanitises an invalid correlation id", async () => {
    const response = await harness.app.inject({
      method: "GET",
      url: "/does-not-exist",
      headers: { "x-correlation-id": "bad value!!" },
    });

    const correlationId = String(response.headers["x-correlation-id"]);
    expect(correlationId).not.toBe("bad value!!");
    expect(correlationId).toMatch(/^[A-Za-z0-9_-]{1,64}$/);

    const parsed = apiErrorSchema.parse(response.json());
    expect(parsed.error.correlation_id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });
});

describe("CORS", () => {
  it("allows the configured app origin", async () => {
    const response = await harness.app.inject({
      method: "GET",
      url: "/health/live",
      headers: { origin: "http://127.0.0.1:8081" },
    });

    expect(response.headers["access-control-allow-origin"]).toBe(
      "http://127.0.0.1:8081",
    );
  });

  it("never allows an unknown origin and never uses a wildcard", async () => {
    const response = await harness.app.inject({
      method: "GET",
      url: "/health/live",
      headers: { origin: "http://evil.example" },
    });

    const allowOrigin = response.headers["access-control-allow-origin"];
    expect(allowOrigin).not.toBe("http://evil.example");
    expect(allowOrigin).not.toBe("*");
    expect(String(allowOrigin ?? "")).not.toContain("evil.example");
  });
});

describe("error handling", () => {
  it("does not leak internal details on a 500", async () => {
    const response = await harness.app.inject({
      method: "GET",
      url: "/__test/boom",
    });

    expect(response.statusCode).toBe(500);

    const body = JSON.parse(response.body) as Record<string, unknown>;
    const parsed = apiErrorSchema.parse(body);
    expect(parsed.error.code).toBe("INTERNAL_ERROR");
    expect(parsed.error.message).not.toContain("boom detail");

    expect(body).not.toHaveProperty("stack");
    expect(response.body).not.toContain("boom detail");
  });

  it("logs the real status code of a failed request", async () => {
    const lines: Array<Record<string, unknown>> = [];
    const capturingLogger: Logger = {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: (_msg, fields) => {
        lines.push((fields ?? {}) as Record<string, unknown>);
      },
      child: () => capturingLogger,
    };

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "personalass-log-"));
    roots.push(root);
    const dbFile = path.join(root, "db", "personalass.sqlite");
    const db = openDatabase(dbFile);
    runMigrations(db, MIGRATIONS_DIR);

    const config = makeConfig(path.join(root, "data"));
    const app = await buildApp({
      config,
      paths: { ...dataPaths(config), dbFile },
      db,
      migrationsDir: MIGRATIONS_DIR,
      logger: capturingLogger,
    });

    app.get("/__test/bad", async () => {
      const error = new Error("bad request") as Error & { statusCode: number };
      error.statusCode = 400;
      throw error;
    });
    app.get("/__test/boom", async () => {
      throw new Error("boom detail");
    });

    await app.inject({ method: "GET", url: "/__test/bad" });
    await app.inject({ method: "GET", url: "/__test/boom" });

    const statuses = lines.map((line) => line["status_code"]);
    // The logged status code must be the real one, not the 200 that
    // reply.statusCode still holds when the error hook runs.
    expect(statuses).toContain(400);
    expect(statuses).toContain(500);
    expect(statuses).not.toContain(200);

    await app.close();
    closeDatabase(db);
  });
});

describe("Host allowlist (DNS-rebinding protection)", () => {
  it("accepts the configured host with and without the port", async () => {
    const withPort = await harness.app.inject({
      method: "GET",
      url: "/health/live",
      headers: { host: "127.0.0.1:4310" },
    });
    expect(withPort.statusCode).toBe(200);
    expect(healthLiveSchema.parse(withPort.json()).status).toBe("ok");

    const withoutPort = await harness.app.inject({
      method: "GET",
      url: "/health/live",
      headers: { host: "127.0.0.1" },
    });
    expect(withoutPort.statusCode).toBe(200);
    expect(healthLiveSchema.parse(withoutPort.json()).status).toBe("ok");

    const localhost = await harness.app.inject({
      method: "GET",
      url: "/health/live",
      headers: { host: "localhost:4310" },
    });
    expect(localhost.statusCode).toBe(200);
  });

  it("rejects a rebound host with 403 and the error envelope", async () => {
    const response = await harness.app.inject({
      method: "GET",
      url: "/health/live",
      headers: { host: "evil.example.com" },
    });

    expect(response.statusCode).toBe(403);

    const raw = response.body;
    const parsed = apiErrorSchema.parse(JSON.parse(raw));
    expect(parsed.error.code).toBe("FORBIDDEN");
    expect(parsed.error.retryable).toBe(false);
    expect(parsed.error.correlation_id.length).toBeGreaterThan(0);
    expect(parsed.error.message.length).toBeGreaterThan(0);

    // The reply must not leak the allowlist contents.
    expect(raw).not.toContain("127.0.0.1");
    expect(raw).not.toContain("localhost");
    expect(raw).not.toContain("[::1]");
    expect(raw).not.toContain("allowedHosts");
  });

  it("rejects the right port with the wrong host name", async () => {
    const response = await harness.app.inject({
      method: "GET",
      url: "/health/live",
      headers: { host: "attacker.local:4310" },
    });

    expect(response.statusCode).toBe(403);

    const parsed = apiErrorSchema.parse(response.json());
    expect(parsed.error.code).toBe("FORBIDDEN");
    expect(parsed.error.retryable).toBe(false);
  });

  it("protects the readiness endpoint as well", async () => {
    const response = await harness.app.inject({
      method: "GET",
      url: "/health/ready",
      headers: { host: "evil.example.com" },
    });

    expect(response.statusCode).toBe(403);

    const parsed = apiErrorSchema.parse(response.json());
    expect(parsed.error.code).toBe("FORBIDDEN");
  });

  it("protects data routes as well", async () => {
    const response = await harness.app.inject({
      method: "POST",
      url: "/__test/echo",
      headers: { host: "evil.example.com" },
      payload: { a: 1 },
    });

    expect(response.statusCode).toBe(403);

    const parsed = apiErrorSchema.parse(response.json());
    expect(parsed.error.code).toBe("FORBIDDEN");
  });

  it("extends the allowlist through ALLOWED_HOSTS", async () => {
    const extended = await createApp({
      allowedHosts: [
        ...buildDefaultAllowedHosts("127.0.0.1", 4310),
        "localhost:80",
        "personalass.local:4310",
      ],
    });

    const accepted = await extended.app.inject({
      method: "GET",
      url: "/health/live",
      headers: { host: "personalass.local:4310" },
    });
    expect(accepted.statusCode).toBe(200);

    const rejected = await extended.app.inject({
      method: "GET",
      url: "/health/live",
      headers: { host: "evil.example.com" },
    });
    expect(rejected.statusCode).toBe(403);

    await extended.app.close();
    closeDatabase(extended.db);
  });
});

/* ------------------------------------------------------------------ */
/* The readiness endpoint must not mutate any state                    */
/* ------------------------------------------------------------------ */

describe("GET /health/ready does not write to the database", () => {
  it("executes no CREATE statement on an already migrated database", async () => {
    const executed: string[] = [];
    const db = harness.db as unknown as {
      exec: (sql: string) => unknown;
    };
    const originalExec = db.exec.bind(db);
    db.exec = (sql: string) => {
      executed.push(sql);
      return originalExec(sql);
    };

    try {
      appliedVersions(harness.db);
      appliedVersions(harness.db);

      const creates = executed.filter((sql) => /\bcreate\b/i.test(sql));
      expect(creates).toEqual([]);

      const response = await harness.app.inject({
        method: "GET",
        url: "/health/ready",
      });
      expect(response.statusCode).toBe(200);

      const createsAfterProbe = executed.filter((sql) => /\bcreate\b/i.test(sql));
      expect(createsAfterProbe).toEqual([]);
    } finally {
      db.exec = originalExec;
    }
  });

  it("creates no file in the data dir", async () => {
    const dataDir = harness.paths.dataDir;

    const listFiles = (dir: string): string[] => {
      if (!fs.existsSync(dir)) return [];
      return fs.readdirSync(dir).sort();
    };

    // Record every write attempt: the probe must not create a probe file.
    const writes: string[] = [];
    const originalWriteFileSync = fs.writeFileSync;
    const originalUnlinkSync = fs.unlinkSync;
    (fs as unknown as { writeFileSync: typeof fs.writeFileSync }).writeFileSync = ((
      ...args: unknown[]
    ) => {
      writes.push(String(args[0]));
      return (originalWriteFileSync as (...a: unknown[]) => void)(...args);
    }) as typeof fs.writeFileSync;
    (fs as unknown as { unlinkSync: typeof fs.unlinkSync }).unlinkSync = ((
      ...args: unknown[]
    ) => {
      writes.push(`unlink:${String(args[0])}`);
      return (originalUnlinkSync as (...a: unknown[]) => void)(...args);
    }) as typeof fs.unlinkSync;

    const before = listFiles(dataDir);
    const beforeAll = fs
      .readdirSync(dataDir, { recursive: true })
      .map(String)
      .sort();

    try {
      await harness.app.inject({ method: "GET", url: "/health/ready" });
      await harness.app.inject({ method: "GET", url: "/health/ready" });
    } finally {
      (fs as unknown as { writeFileSync: typeof fs.writeFileSync }).writeFileSync =
        originalWriteFileSync;
      (fs as unknown as { unlinkSync: typeof fs.unlinkSync }).unlinkSync =
        originalUnlinkSync;
    }

    expect(writes).toEqual([]);
    expect(listFiles(dataDir)).toEqual(before);
    expect(
      fs.readdirSync(dataDir, { recursive: true }).map(String).sort(),
    ).toEqual(beforeAll);
  });
});

/* ------------------------------------------------------------------ */
/* The HTTP status and the envelope code must always agree             */
/* ------------------------------------------------------------------ */

describe("error status and code agreement", () => {
  it("reports a 415 as BAD_REQUEST with status 400", async () => {
    const response = await harness.app.inject({
      method: "GET",
      url: "/__test/unsupported-media",
    });

    expect(response.statusCode).toBe(400);

    const parsed = apiErrorSchema.parse(response.json());
    expect(parsed.error.code).toBe("BAD_REQUEST");
    expect(apiErrorStatusByCode[parsed.error.code]).toBe(response.statusCode);
    expect(parsed.error.retryable).toBe(false);
  });

  it("reports a 503 as INTERNAL_ERROR with status 500", async () => {
    const response = await harness.app.inject({
      method: "GET",
      url: "/__test/unavailable",
    });

    expect(response.statusCode).toBe(500);

    const parsed = apiErrorSchema.parse(response.json());
    expect(parsed.error.code).toBe("INTERNAL_ERROR");
    expect(apiErrorStatusByCode[parsed.error.code]).toBe(response.statusCode);
    expect(parsed.error.retryable).toBe(true);
  });

  it("never leaks the internal detail of an unmapped status", async () => {
    const response = await harness.app.inject({
      method: "GET",
      url: "/__test/unavailable",
    });

    expect(response.body).not.toContain("service unavailable");
  });
});

describe("Host allowlist configuration", () => {  it("derives the default allowlist from HOST and PORT", () => {
    const config = loadConfig({
      ...process.env,
      HOST: "127.0.0.1",
      PORT: "4310",
    });

    expect(config.allowedHosts).toContain("127.0.0.1:4310");
    expect(config.allowedHosts).toContain("localhost:4310");
    expect(config.allowedHosts).toContain("[::1]:4310");
    expect(config.allowedHosts).toContain("127.0.0.1");
    expect(config.allowedHosts).toContain("localhost");
    expect(config.allowedHosts).toContain("[::1]");
    expect(config.allowedHosts).not.toContain("*");
  });

  it("adds ALLOWED_HOSTS entries on top of the default list", () => {
    const config = loadConfig({
      ...process.env,
      HOST: "127.0.0.1",
      PORT: "4310",
      ALLOWED_HOSTS: "personalass.local:4310, personalass.local",
    });

    expect(config.allowedHosts).toContain("personalass.local:4310");
    expect(config.allowedHosts).toContain("personalass.local");
    expect(config.allowedHosts).toContain("127.0.0.1:4310");
  });

  it("never turns the allowlist into a wildcard", () => {
    const config = loadConfig({
      ...process.env,
      HOST: "127.0.0.1",
      PORT: "4310",
      ALLOWED_HOSTS: "*",
    });

    expect(config.allowedHosts).not.toContain("*");
    expect(config.allowedHosts).toContain("127.0.0.1:4310");
  });
});
