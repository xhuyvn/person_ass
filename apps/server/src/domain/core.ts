import { createHash, randomUUID } from "node:crypto";
import type { z } from "zod";
import { apiErrorStatusByCode, type ApiErrorCode } from "@personalass/contracts";
import type { Db } from "../db/open.js";
import { transaction } from "../db/open.js";

/** Single-owner product (D01): every row carries this constant owner id. */
export const OWNER_ID = "owner";

export type Clock = () => Date;

export type Ctx = {
  db: Db;
  clock: Clock;
  correlationId?: string;
  /** Audit attribution for writes made through this context (default user/manual). */
  actor?: "user" | "ai" | "system";
  actionGroupId?: string;
  auditSource?: string;
};

export class DomainError extends Error {
  readonly statusCode: number;
  readonly fieldErrors?: Record<string, string>;
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    fieldErrors?: Record<string, string>,
  ) {
    super(message);
    this.statusCode = apiErrorStatusByCode[code];
    this.fieldErrors = fieldErrors;
  }
}

export const notFound = (what: string): DomainError =>
  new DomainError("NOT_FOUND", `${what} không tồn tại.`);

export const versionConflict = (what: string): DomainError =>
  new DomainError(
    "CONFLICT",
    `${what} đã được thay đổi ở nơi khác (version không khớp). Tải lại rồi thử lại.`,
  );

/** Validate with a Zod schema and turn failures into a 400 with field_errors. */
export function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input ?? {});
  if (result.success) return result.data;
  const fieldErrors: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const key = issue.path.length > 0 ? issue.path.join(".") : "_";
    if (!(key in fieldErrors)) fieldErrors[key] = issue.message;
  }
  throw new DomainError("BAD_REQUEST", "Dữ liệu không hợp lệ.", fieldErrors);
}

export const nowIso = (ctx: Ctx): string => ctx.clock().toISOString();

export const newId = (): string => randomUUID();

export function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export type Row = Record<string, unknown>;

export function writeAudit(
  ctx: Ctx,
  e: {
    actor?: "user" | "ai" | "system";
    action: string;
    entityType: string;
    entityId: string;
    before?: unknown;
    after?: unknown;
    versions?: unknown;
  },
): void {
  const now = nowIso(ctx);
  ctx.db
    .prepare(
      `INSERT INTO audit_events
        (id, owner_id, actor, action, entity_type, entity_id, action_group_id, before_json, after_json,
         versions_json, source, correlation_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      newId(),
      OWNER_ID,
      e.actor ?? ctx.actor ?? "user",
      e.action,
      e.entityType,
      e.entityId,
      ctx.actionGroupId ?? null,
      e.before === undefined ? null : JSON.stringify(e.before),
      e.after === undefined ? null : JSON.stringify(e.after),
      e.versions === undefined ? null : JSON.stringify(e.versions),
      ctx.auditSource ?? "manual",
      ctx.correlationId ?? null,
      now,
      now,
    );
}

/* ---- idempotency (docs/03 §5) ---- */

export type Outcome<T> = { status: number; body: T };

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Run `fn` in one transaction. With an Idempotency-Key the first outcome is
 * stored and replayed for the same key+body; a different body is a 409.
 */
export function idempotent<T>(
  ctx: Ctx,
  key: string | undefined,
  scope: string,
  requestBody: unknown,
  fn: () => Outcome<T>,
): Outcome<T> {
  if (key !== undefined && !/^[A-Za-z0-9_-]{8,128}$/.test(key)) {
    throw new DomainError("BAD_REQUEST", "Idempotency-Key không hợp lệ.");
  }
  return transaction(ctx.db, () => {
    if (key === undefined) return fn();
    const hash = stableHash(requestBody);
    const existing = ctx.db
      .prepare(
        "SELECT request_hash, response_ref, expires_at FROM request_idempotency WHERE owner_id = ? AND key = ? AND route_scope = ?",
      )
      .get(OWNER_ID, key, scope) as Row | undefined;
    if (existing && String(existing.expires_at) > nowIso(ctx)) {
      if (existing.request_hash !== hash) {
        throw new DomainError("CONFLICT", "Idempotency-Key đã dùng với nội dung khác.");
      }
      return JSON.parse(String(existing.response_ref)) as Outcome<T>;
    }
    const outcome = fn();
    const now = nowIso(ctx);
    const expires = new Date(ctx.clock().getTime() + IDEMPOTENCY_TTL_MS).toISOString();
    ctx.db
      .prepare(
        `INSERT INTO request_idempotency
           (id, owner_id, key, route_scope, request_hash, response_ref, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (owner_id, key, route_scope) DO UPDATE SET
           request_hash = excluded.request_hash, response_ref = excluded.response_ref,
           expires_at = excluded.expires_at, updated_at = excluded.updated_at`,
      )
      .run(newId(), OWNER_ID, key, scope, hash, JSON.stringify(outcome), expires, now, now);
    return outcome;
  });
}

/* ---- cursor pagination (newest first) ---- */

export type Page<T> = { items: T[]; next_cursor: string | null };

export function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(`${createdAt}|${id}`).toString("base64url");
}

export function decodeCursor(cursor: string | undefined): { createdAt: string; id: string } | null {
  if (!cursor) return null;
  const [createdAt, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  if (!createdAt || !id) throw new DomainError("BAD_REQUEST", "cursor không hợp lệ.");
  return { createdAt, id };
}

export function pageRows<T extends Row>(rows: T[], limit: number): { rows: T[]; next: string | null } {
  if (rows.length <= limit) return { rows, next: null };
  const kept = rows.slice(0, limit);
  const last = kept[kept.length - 1] as T;
  return { rows: kept, next: encodeCursor(String(last.created_at), String(last.id)) };
}

/* ---- settings ---- */

export type EffectiveSettings = {
  timezone: string;
  dateOnlyTime: string;
  timedOffsetMinutes: number;
};

export function loadSettings(ctx: Ctx): EffectiveSettings {
  const now = nowIso(ctx);
  ctx.db
    .prepare(
      `INSERT OR IGNORE INTO settings (id, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?)`,
    )
    .run(newId(), OWNER_ID, now, now);
  const row = ctx.db
    .prepare("SELECT timezone, reminder_defaults_json FROM settings WHERE owner_id = ?")
    .get(OWNER_ID) as Row;
  let defaults: { date_only_time?: string; timed_offset_minutes?: number } = {};
  try {
    defaults = JSON.parse(String(row.reminder_defaults_json));
  } catch {
    defaults = {};
  }
  return {
    timezone: String(row.timezone),
    dateOnlyTime: defaults.date_only_time ?? "09:00",
    timedOffsetMinutes: defaults.timed_offset_minutes ?? -30,
  };
}
