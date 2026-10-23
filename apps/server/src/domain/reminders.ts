import type { ReminderRule, ReminderRuleCreate } from "@personalass/contracts";
import {
  DomainError,
  OWNER_ID,
  loadSettings,
  newId,
  notFound,
  nowIso,
  writeAudit,
  type Ctx,
  type Row,
} from "./core.js";
import { localToUtc } from "./time.js";

type Anchor = "due_date" | "due_at" | "starts_at" | "local_date";

type Target = {
  anchor: Anchor;
  /** Instant or YYYY-MM-DD, depending on the anchor. */
  value: string;
  timezone: string;
};

function loadEntity(ctx: Ctx, type: string, id: string): Row | undefined {
  const table = type === "task" ? "tasks" : type === "appointment" ? "appointments" : null;
  if (!table) return undefined;
  return ctx.db.prepare(`SELECT * FROM ${table} WHERE id = ? AND owner_id = ?`).get(id, OWNER_ID) as
    | Row
    | undefined;
}

function isActive(type: string, row: Row): boolean {
  if (row.archived_at) return false;
  if (type === "task") return row.status !== "done" && row.status !== "archived";
  return row.status === "scheduled";
}

function targetOf(ctx: Ctx, type: string, row: Row): Target | null {
  const tz = loadSettings(ctx).timezone;
  if (type === "task") {
    if (row.due_at) return { anchor: "due_at", value: String(row.due_at), timezone: tz };
    if (row.due_date) return { anchor: "due_date", value: String(row.due_date), timezone: tz };
    return null; // docs/05 §3: no deadline, no reminder (A01)
  }
  const apptTz = String(row.timezone);
  if (row.all_day) return { anchor: "local_date", value: String(row.local_date), timezone: apptTz };
  if (row.starts_at) return { anchor: "starts_at", value: String(row.starts_at), timezone: apptTz };
  return null;
}

function scheduledAt(target: Target, offsetMinutes: number, localTime: string): string {
  const isDateAnchor = target.anchor === "due_date" || target.anchor === "local_date";
  const base = isDateAnchor
    ? localToUtc(target.value, localTime, target.timezone).getTime()
    : Date.parse(target.value);
  return new Date(base + offsetMinutes * 60_000).toISOString();
}

function cancelPending(ctx: Ctx, ruleId: string, now: string): void {
  ctx.db
    .prepare(
      `UPDATE occurrences SET status = 'cancelled', version = version + 1, updated_at = ?
       WHERE rule_id = ? AND status = 'pending'`,
    )
    .run(now, ruleId);
}

/**
 * Re-derive reminder state for an entity after it changed. Must be called in
 * the same transaction as the entity write (docs/05 §3: cancel old + create
 * new atomically; A31).
 */
export function syncReminders(
  ctx: Ctx,
  type: "task" | "appointment",
  row: Row,
  opts: { createDefault: boolean },
): void {
  const now = nowIso(ctx);
  const settings = loadSettings(ctx);
  const entityId = String(row.id);
  const rules = ctx.db
    .prepare("SELECT * FROM reminder_rules WHERE entity_type = ? AND entity_id = ? AND owner_id = ?")
    .all(type, entityId, OWNER_ID) as Row[];
  const target = targetOf(ctx, type, row);
  const active = isActive(type, row);

  if (rules.length === 0 && opts.createDefault && active && target) {
    const isDate = target.anchor === "due_date" || target.anchor === "local_date";
    createRuleRow(ctx, {
      type,
      entityId,
      anchor: target.anchor,
      offset: isDate ? 0 : settings.timedOffsetMinutes,
      localTime: isDate ? settings.dateOnlyTime : null,
      target,
      now,
    });
    return;
  }

  for (const rule of rules) {
    if (!rule.enabled) continue;
    cancelPending(ctx, String(rule.id), now);
    if (!active || !target) continue;

    const isDate = target.anchor === "due_date" || target.anchor === "local_date";
    const anchorChanged = rule.anchor !== target.anchor;
    const offset = anchorChanged ? (isDate ? 0 : settings.timedOffsetMinutes) : Number(rule.offset_minutes);
    const localTime = isDate
      ? ((anchorChanged ? null : (rule.local_time as string | null)) ?? settings.dateOnlyTime)
      : null;
    const revision = Number(rule.schedule_revision) + 1;
    ctx.db
      .prepare(
        `UPDATE reminder_rules SET anchor = ?, offset_minutes = ?, local_time = ?,
           schedule_revision = ?, version = version + 1, updated_at = ? WHERE id = ?`,
      )
      .run(target.anchor, offset, localTime, revision, now, String(rule.id));
    insertOccurrence(ctx, String(rule.id), "main", scheduledAt(target, offset, localTime ?? "00:00"), revision, now);
  }
}

function insertOccurrence(
  ctx: Ctx,
  ruleId: string,
  key: string,
  at: string,
  revision: number,
  now: string,
): void {
  ctx.db
    .prepare(
      `INSERT OR IGNORE INTO occurrences
         (id, owner_id, rule_id, occurrence_key, scheduled_at, status, schedule_revision, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
    )
    .run(newId(), OWNER_ID, ruleId, key, at, revision, now, now);
}

function createRuleRow(
  ctx: Ctx,
  a: {
    type: string;
    entityId: string;
    anchor: Anchor;
    offset: number;
    localTime: string | null;
    target: Target;
    now: string;
  },
): string {
  const id = newId();
  ctx.db
    .prepare(
      `INSERT INTO reminder_rules
         (id, owner_id, entity_type, entity_id, anchor, offset_minutes, local_time, enabled,
          schedule_revision, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)`,
    )
    .run(id, OWNER_ID, a.type, a.entityId, a.anchor, a.offset, a.localTime, a.now, a.now);
  insertOccurrence(ctx, id, "main", scheduledAt(a.target, a.offset, a.localTime ?? "00:00"), 1, a.now);
  writeAudit(ctx, {
    action: "reminder_rule.create",
    entityType: a.type,
    entityId: a.entityId,
    after: { rule_id: id, anchor: a.anchor, offset_minutes: a.offset, local_time: a.localTime, provenance: "user_default" },
  });
  return id;
}

/** Explicit, user-requested rule (POST /reminder-rules). */
export function createReminderRule(ctx: Ctx, input: ReminderRuleCreate): ReminderRule {
  const row = loadEntity(ctx, input.entity_type, input.entity_id);
  if (!row) throw notFound("Đối tượng");
  if (!isActive(input.entity_type, row)) {
    throw new DomainError("UNPROCESSABLE_ENTITY", "Đối tượng đã hoàn thành hoặc đã lưu trữ.");
  }
  const target = targetOf(ctx, input.entity_type, row);
  if (!target) {
    throw new DomainError("UNPROCESSABLE_ENTITY", "Đối tượng chưa có hạn/giờ để gắn nhắc.");
  }
  const isDate = target.anchor === "due_date" || target.anchor === "local_date";
  const localTime = isDate ? (input.local_time ?? loadSettings(ctx).dateOnlyTime) : null;
  const id = createRuleRow(ctx, {
    type: input.entity_type,
    entityId: input.entity_id,
    anchor: target.anchor,
    offset: input.offset_minutes,
    localTime,
    target,
    now: nowIso(ctx),
  });
  return getReminderRule(ctx, id);
}

export function getReminderRule(ctx: Ctx, id: string): ReminderRule {
  const rule = ctx.db
    .prepare("SELECT * FROM reminder_rules WHERE id = ? AND owner_id = ?")
    .get(id, OWNER_ID) as Row | undefined;
  if (!rule) throw notFound("Quy tắc nhắc");
  return toRule(ctx, rule);
}

export function listReminderRules(ctx: Ctx, entityId?: string): ReminderRule[] {
  const rows = (
    entityId
      ? ctx.db
          .prepare("SELECT * FROM reminder_rules WHERE owner_id = ? AND entity_id = ? ORDER BY created_at")
          .all(OWNER_ID, entityId)
      : ctx.db.prepare("SELECT * FROM reminder_rules WHERE owner_id = ? ORDER BY created_at").all(OWNER_ID)
  ) as Row[];
  return rows.map((r) => toRule(ctx, r));
}

function toRule(ctx: Ctx, r: Row): ReminderRule {
  const next = ctx.db
    .prepare(
      "SELECT MIN(scheduled_at) AS at FROM occurrences WHERE rule_id = ? AND status = 'pending'",
    )
    .get(String(r.id)) as Row;
  return {
    id: String(r.id),
    entity_type: String(r.entity_type),
    entity_id: String(r.entity_id),
    anchor: String(r.anchor),
    offset_minutes: Number(r.offset_minutes),
    local_time: (r.local_time as string | null) ?? null,
    enabled: Boolean(r.enabled),
    schedule_revision: Number(r.schedule_revision),
    version: Number(r.version),
    next_at: (next.at as string | null) ?? null,
  };
}
