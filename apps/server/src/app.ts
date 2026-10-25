import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import { randomUUID } from "node:crypto";
import type { ApiErrorCode } from "@personalass/contracts";
import { apiErrorSchema, apiErrorStatusByCode } from "@personalass/contracts";
import { toErrorEnvelope } from "@personalass/contracts/errors";
import type { Config, DataPaths } from "./config.js";
import { isAllowedHost } from "./config.js";
import type { Db } from "./db/open.js";
import { registerHealthRoutes } from "./api/health.js";
import { buildOpenApi, registerV1Routes } from "./api/v1.js";
import type { Clock } from "./domain/core.js";
import type { AiDeps } from "./domain/ai-config.js";
import { policyTransport } from "./ai/net-policy.js";
import { appVersion } from "./version.js";
import { createLogger, type Logger } from "./logger.js";

const CORRELATION_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export type AppDeps = {
  config: Config;
  paths: DataPaths;
  db: Db;
  migrationsDir: string;
  logger?: Logger;
  /** Injectable for deterministic tests (docs/05 §6). */
  clock?: Clock;
  /** Master-key box and outbound transport for the AI layer. */
  ai?: AiDeps;
  onJobQueued?: () => void;
};

export function resolveCorrelationId(request: FastifyRequest): string {
  const raw = request.headers["x-correlation-id"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value === "string" && CORRELATION_PATTERN.test(value)) {
    return value;
  }
  return randomUUID();
}

/**
 * Map an HTTP status to the error envelope code.
 *
 * The documented mapping (docs/03 §4) is kept as is. Every other status is
 * folded into a documented code so that `code` and the HTTP status can never
 * disagree (a client switching on `code` must not see a client error reported
 * as a retryable server error).
 */
function statusToCode(statusCode: number): ApiErrorCode {
  switch (statusCode) {
    case 400:
      return "BAD_REQUEST";
    case 401:
      return "UNAUTHORIZED";
    case 403:
      return "FORBIDDEN";
    case 404:
      return "NOT_FOUND";
    case 409:
      return "CONFLICT";
    case 413:
      return "PAYLOAD_TOO_LARGE";
    case 422:
      return "UNPROCESSABLE_ENTITY";
    case 429:
      return "RATE_LIMITED";
    case 500:
      return "INTERNAL_ERROR";
    // 415 (unsupported media type) and the other unmapped 4xx are client
    // errors: report them as BAD_REQUEST.
    case 415:
      return "BAD_REQUEST";
    // 501/502/503/504 are server errors.
    case 501:
    case 502:
    case 503:
    case 504:
      return "INTERNAL_ERROR";
    default:
      break;
  }

  if (statusCode >= 400 && statusCode < 500) return "BAD_REQUEST";
  return "INTERNAL_ERROR";
}

/**
 * Resolve the status and the envelope code of a failed request.
 *
 * The status is always the documented status of the code (see
 * `apiErrorStatusByCode`), so the HTTP status and `error.code` always agree.
 */
export function resolveErrorOutcome(error: unknown): {
  status: number;
  code: ApiErrorCode;
} {
  const err = error as {
    statusCode?: number;
    validation?: unknown;
  };

  let rawStatus = 500;
  if (Boolean(err.validation)) rawStatus = 400;
  else if (typeof err.statusCode === "number" && err.statusCode >= 400) {
    rawStatus = err.statusCode;
  }

  const code = statusToCode(rawStatus);
  return { status: apiErrorStatusByCode[code], code };
}

/**
 * Status code an error is reported with. Shared by the error handler and the
 * error log so the logged status code is always the real one.
 */
function resolveErrorStatusCode(error: unknown): number {
  return resolveErrorOutcome(error).status;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Origin check for state-changing requests. No Origin header (curl, tests,
 * same-process tools) is accepted; otherwise the Origin must be an allowed
 * app origin or the server's own origin (same-origin web build).
 */
export function isAllowedOrigin(request: FastifyRequest, appOrigins: readonly string[]): boolean {
  const raw = request.headers.origin;
  const origin = Array.isArray(raw) ? raw[0] : raw;
  if (origin === undefined) return true;
  if (origin === "null") return false;
  if (appOrigins.includes(origin)) return true;
  const host = request.headers.host;
  return host !== undefined && (origin === `http://${host}` || origin === `https://${host}`);
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const logger = deps.logger ?? createLogger(deps.config.LOG_LEVEL);
  const app = Fastify({
    logger: false,
    bodyLimit: deps.config.MAX_UPLOAD_BYTES,
    trustProxy: deps.config.trustProxy,
  });

  // The Host guard runs BEFORE the CORS plugin is registered so that a
  // rebound (or preflight) request can never reach any route, not even the
  // health endpoints (docs/06 §1: "Chặn DNS rebinding bằng allowed Host
  // chính xác").
  app.addHook("onRequest", async (request, reply) => {
    const scoped = request as FastifyRequest & { correlationId: string };
    scoped.correlationId = resolveCorrelationId(request);

    if (!isAllowedHost(request.headers.host, deps.config.allowedHosts)) {
      // The reply must not reveal anything about the allowlist.
      reply.code(403);
      reply.header("x-correlation-id", scoped.correlationId);
      return reply.send(
        apiErrorSchema.parse(
          toErrorEnvelope("FORBIDDEN", "Host không được phép.", {
            correlationId: scoped.correlationId,
            retryable: false,
          }),
        ),
      );
    }

    // Mutations from a foreign website (docs/06 §1, A28): browsers always send
    // Origin on cross-origin POST/PATCH/PUT/DELETE, so a mismatching Origin is
    // refused before any route runs. Non-browser local clients send no Origin.
    if (!SAFE_METHODS.has(request.method) && !isAllowedOrigin(request, deps.config.appOrigins)) {
      reply.code(403);
      reply.header("x-correlation-id", scoped.correlationId);
      return reply.send(
        apiErrorSchema.parse(
          toErrorEnvelope("FORBIDDEN", "Origin không được phép.", {
            correlationId: scoped.correlationId,
            retryable: false,
          }),
        ),
      );
    }
  });

  await app.register(cors, {
    origin: deps.config.appOrigins,
    credentials: false,
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
  });

  app.addHook("onSend", async (request, reply, payload) => {
    const correlationId = (request as FastifyRequest & { correlationId?: string })
      .correlationId;
    if (correlationId) reply.header("x-correlation-id", correlationId);
    return payload;
  });

  app.addHook("onError", async (request, reply, error) => {
    logger.error("request_failed", {
      correlation_id: (request as FastifyRequest & { correlationId?: string })
        .correlationId,
      method: request.method,
      url: request.url,
      // reply.statusCode is still 200 at this point: the error handler sets
      // the real status code afterwards, so it is derived the same way.
      status_code: resolveErrorStatusCode(error),
      error: error.message,
    });
  });

  app.setErrorHandler((error, request, reply) => {
    const correlationId = (request as FastifyRequest & { correlationId?: string })
      .correlationId ?? randomUUID();

    const err = error as {
      message?: string;
      statusCode?: number;
      validation?: Array<{ field?: string; message?: string }>;
      fieldErrors?: Record<string, string>;
    };

    const { status: statusCode, code } = resolveErrorOutcome(error);

    const message =
      statusCode >= 500
        ? "Internal server error"
        : err.message || "Request failed";

    const fieldErrors: Record<string, string> = { ...(err.fieldErrors ?? {}) };
    const details = err.validation;
    if (Array.isArray(details)) {
      for (const detail of details) {
        if (detail.field) fieldErrors[detail.field] = detail.message ?? "Invalid value";
      }
    }

    const envelope = toErrorEnvelope(code, message, {
      correlationId,
      fieldErrors,
      retryable: code === "RATE_LIMITED" || code === "INTERNAL_ERROR",
    });

    reply.code(statusCode);
    return reply.send(apiErrorSchema.parse(envelope));
  });

  app.setNotFoundHandler((request, reply) => {
    const correlationId = (request as FastifyRequest & { correlationId?: string })
      .correlationId ?? randomUUID();
    reply.code(404);
    return reply.send(
      apiErrorSchema.parse(
        toErrorEnvelope("NOT_FOUND", "Route not found", { correlationId }),
      ),
    );
  });

  await registerHealthRoutes(app, {
    db: deps.db,
    paths: deps.paths,
    migrationsDir: deps.migrationsDir,
  });

  const ops = await registerV1Routes(app, {
    db: deps.db,
    clock: deps.clock ?? (() => new Date()),
    ai: deps.ai ?? { secrets: null, transport: policyTransport },
    onJobQueued: deps.onJobQueued,
  });
  const openapi = buildOpenApi(ops, appVersion());
  app.get("/api/v1/openapi.json", async () => openapi);

  return app;
}

export type { FastifyReply };
