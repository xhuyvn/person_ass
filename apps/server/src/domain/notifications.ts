import type { ListQuery, Notification } from "@personalass/contracts";
import {
  DomainError,
  OWNER_ID,
  decodeCursor,
  newId,
  notFound,
  nowIso,
  pageRows,
  writeAudit,
  type Ctx,
  type Page,
  type Row,
} from "./core.js";
import { transaction } from "../db/open.js";

/** Within this window after scheduled_at a reminder fires normally (docs/05 §5). */
export const DEFAULT_MISSED_THRESHOLD_MS = 10 * 60_000;
const DIGEST_TITLES = 10;

const s = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

export const toNotification = (r: Row): Notification => ({
  id: String(r.id),
  kind: r.kind as Notification["kind"],
  title: String(r.title),
  body: String(r.body),
  entity_type: s(r.entity_type),
  entity_id: s(r.entity_id),
  scheduled_at: s(r.scheduled_at),
  state: r.state as Notification["state"],
  created_at: String(r.created_at),
  acknowledged_at: s(r.acknowledged_at),
});

function entityState(ctx: Ctx, type: string, id: string): { title: string; active: boolean } {
  const table = type === "task" ? "tasks" : "appointments";
  const row = ctx.db.prepare(`SELECT title, status, archived_at FROM ${table} WHERE id = ?`).get(id) as
    | Row
    | undefined;
  if (!row) return { title: "(đã xóa)", active: false };
  const active = !row.archived_at && (type === "task" ? row.status !== "done" && row.status !== "archived" : row.status === "scheduled");
  return { title: String(row.title), active };
}

const entityTitle = (ctx: Ctx, type: string, id: string): string => entityState(ctx, type, id).title;

function createAttempt(ctx: Ctx, notificationId: string, state: string, now: string): void {
  ctx.db
    .prepare(
      `INSERT INTO delivery_attempts (id, notification_id, channel, state, delivered_at, created_at, updated_at)
       VALUES (?, ?, 'in_app', ?, ?, ?, ?)`,
    )
    .run(newId(), notificationId, state, state === "delivered" ? now : null, now, now);
}

export type TickResult = { reminders: number; missed: number; digests: number };

/**
 * One scheduler pass (docs/05 §4): atomically turn every due, still-pending
 * occurrence into a persistent in-app notification. Occurrences older than the
 * threshold are folded into a single digest and marked `missed`, never
 * deleted. Crash-safe: the claim, the notification and the status change are
 * one transaction, and UNIQUE(occurrence_id, channel) stops duplicates.
 */
export function runSchedulerTick(
  ctx: Ctx,
  missedThresholdMs: number = DEFAULT_MISSED_THRESHOLD_MS,
): TickResult {
  return transaction(ctx.db, () => {
    const nowMs = ctx.clock().getTime();
    const now = new Date(nowMs).toISOString();
    const due = ctx.db
      .prepare(
        `SELECT o.id, o.scheduled_at, o.schedule_revision, r.entity_type, r.entity_id,
                r.schedule_revision AS rule_revision, r.enabled
         FROM occurrences o JOIN reminder_rules r ON r.id = o.rule_id
         WHERE o.status = 'pending' AND o.scheduled_at <= ? AND o.owner_id = ?
         ORDER BY o.scheduled_at, o.id`,
      )
      .all(now, OWNER_ID) as Row[];

    const result: TickResult = { reminders: 0, missed: 0, digests: 0 };
    const missed: Row[] = [];

    for (const occ of due) {
      // Revalidate against the rule: a stale revision or disabled rule must
      // never notify (A31).
      if (
        !occ.enabled ||
        Number(occ.schedule_revision) !== Number(occ.rule_revision) ||
        !entityState(ctx, String(occ.entity_type), String(occ.entity_id)).active
      ) {
        ctx.db
          .prepare("UPDATE occurrences SET status = 'cancelled', updated_at = ?, version = version + 1 WHERE id = ?")
          .run(now, String(occ.id));
        continue;
      }
      const age = nowMs - Date.parse(String(occ.scheduled_at));
      if (age > missedThresholdMs) {
        missed.push(occ);
        continue;
      }
      const title = entityTitle(ctx, String(occ.entity_type), String(occ.entity_id));
      const notificationId = newId();
      const inserted = ctx.db
        .prepare(
          `INSERT OR IGNORE INTO notifications
             (id, owner_id, occurrence_id, kind, title, body, entity_type, entity_id, scheduled_at,
              created_at, updated_at)
           VALUES (?, ?, ?, 'reminder', ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          notificationId,
          OWNER_ID,
          String(occ.id),
          title,
          occ.entity_type === "task" ? "Nhắc việc" : "Nhắc lịch hẹn",
          String(occ.entity_type),
          String(occ.entity_id),
          String(occ.scheduled_at),
          now,
          now,
        );
      if (Number(inserted.changes) > 0) {
        createAttempt(ctx, notificationId, "created", now);
        result.reminders += 1;
      }
      ctx.db
        .prepare("UPDATE occurrences SET status = 'processed', processed_at = ?, updated_at = ?, version = version + 1 WHERE id = ?")
        .run(now, now, String(occ.id));
    }

    if (missed.length > 0) {
      const items = missed.map((m) => ({
        occurrence_id: String(m.id),
        entity_type: String(m.entity_type),
        entity_id: String(m.entity_id),
        title: entityTitle(ctx, String(m.entity_type), String(m.entity_id)),
        scheduled_at: String(m.scheduled_at),
      }));
      const notificationId = newId();
      const shown = items.slice(0, DIGEST_TITLES).map((i) => i.title).join("; ");
      const more = items.length > DIGEST_TITLES ? ` và ${items.length - DIGEST_TITLES} mục khác` : "";
      ctx.db
        .prepare(
          `INSERT INTO notifications (id, owner_id, kind, title, body, digest_json, scheduled_at, created_at, updated_at)
           VALUES (?, ?, 'digest', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          notificationId,
          OWNER_ID,
          `${items.length} nhắc nhở bị lỡ`,
          `${shown}${more}`,
          JSON.stringify(items.slice(0, 200)),
          items[0]?.scheduled_at ?? null,
          now,
          now,
        );
      createAttempt(ctx, notificationId, "created", now);
      for (const m of missed) {
        ctx.db
          .prepare("UPDATE occurrences SET status = 'missed', processed_at = ?, updated_at = ?, version = version + 1 WHERE id = ?")
          .run(now, now, String(m.id));
      }
      result.missed = missed.length;
      result.digests = 1;
    }
    return result;
  });
}

/** List persistent notifications; unseen ones are marked delivered (docs/05 §4 step 4). */
export function listNotifications(ctx: Ctx, q: ListQuery): Page<Notification> {
  return transaction(ctx.db, () => {
    const cursor = decodeCursor(q.cursor);
    const args: unknown[] = [OWNER_ID];
    let where = "owner_id = ?";
    if (q.unread === "true") where += " AND state != 'acknowledged'";
    if (cursor) {
      where += " AND (created_at < ? OR (created_at = ? AND id < ?))";
      args.push(cursor.createdAt, cursor.createdAt, cursor.id);
    }
    args.push(q.limit + 1);
    const rows = ctx.db
      .prepare(`SELECT * FROM notifications WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(...(args as never[])) as Row[];
    const { rows: kept, next } = pageRows(rows, q.limit);
    const now = nowIso(ctx);
    for (const r of kept) {
      if (r.state === "created") {
        ctx.db
          .prepare("UPDATE notifications SET state = 'delivered', delivered_at = ?, updated_at = ?, version = version + 1 WHERE id = ?")
          .run(now, now, String(r.id));
        createAttempt(ctx, String(r.id), "delivered", now);
        r.state = "delivered";
      }
    }
    return { items: kept.map(toNotification), next_cursor: next };
  });
}

function requireNotification(ctx: Ctx, id: string): Row {
  const row = ctx.db.prepare("SELECT * FROM notifications WHERE id = ? AND owner_id = ?").get(id, OWNER_ID) as
    | Row
    | undefined;
  if (!row) throw notFound("Thông báo");
  return row;
}

/** Idempotent acknowledge. */
export function ackNotification(ctx: Ctx, id: string): Notification {
  return transaction(ctx.db, () => {
    const row = requireNotification(ctx, id);
    if (row.state !== "acknowledged") {
      const now = nowIso(ctx);
      ctx.db
        .prepare("UPDATE notifications SET state = 'acknowledged', acknowledged_at = ?, updated_at = ?, version = version + 1 WHERE id = ?")
        .run(now, now, id);
      createAttempt(ctx, id, "acknowledged", now);
      writeAudit(ctx, { action: "notification.ack", entityType: "notification", entityId: id });
    }
    return toNotification(requireNotification(ctx, id));
  });
}

/**
 * Snooze creates a one-off occurrence on the same rule; the deadline and the
 * original reminder rule schedule are untouched (docs/03 §4).
 */
export function snoozeNotification(ctx: Ctx, id: string, minutes: number): Notification {
  return transaction(ctx.db, () => {
    const row = requireNotification(ctx, id);
    if (row.kind !== "reminder" || !row.occurrence_id) {
      throw new DomainError("UNPROCESSABLE_ENTITY", "Chỉ có thể hoãn thông báo nhắc đơn lẻ.");
    }
    const occ = ctx.db.prepare("SELECT * FROM occurrences WHERE id = ?").get(String(row.occurrence_id)) as Row;
    const rule = ctx.db.prepare("SELECT schedule_revision FROM reminder_rules WHERE id = ?").get(String(occ.rule_id)) as Row;
    const now = nowIso(ctx);
    const at = new Date(ctx.clock().getTime() + minutes * 60_000).toISOString();
    const n = (ctx.db
      .prepare("SELECT COUNT(*) AS n FROM occurrences WHERE rule_id = ? AND occurrence_key LIKE ?")
      .get(String(occ.rule_id), `snooze:${id}:%`) as Row).n;
    ctx.db
      .prepare(
        `INSERT INTO occurrences (id, owner_id, rule_id, occurrence_key, scheduled_at, status, schedule_revision,
           created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      )
      .run(newId(), OWNER_ID, String(occ.rule_id), `snooze:${id}:${Number(n) + 1}`, at, Number(rule.schedule_revision), now, now);
    if (row.state !== "acknowledged") {
      ctx.db
        .prepare("UPDATE notifications SET state = 'acknowledged', acknowledged_at = ?, updated_at = ?, version = version + 1 WHERE id = ?")
        .run(now, now, id);
    }
    writeAudit(ctx, { action: "notification.snooze", entityType: "notification", entityId: id, after: { until: at } });
    return toNotification(requireNotification(ctx, id));
  });
}
