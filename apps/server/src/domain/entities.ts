import type {
  Appointment,
  AppointmentCreate,
  AppointmentPatch,
  ListQuery,
  Note,
  NoteCreate,
  NotePatch,
  SourceRef,
  Task,
  TaskCreate,
  TaskPatch,
} from "@personalass/contracts";
import {
  DomainError,
  OWNER_ID,
  decodeCursor,
  newId,
  notFound,
  nowIso,
  pageRows,
  versionConflict,
  writeAudit,
  type Ctx,
  type Page,
  type Row,
} from "./core.js";
import { syncReminders } from "./reminders.js";
import { assertValidTimeZone } from "./time.js";

/* ---- mappers ---- */

const s = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

export const toTask = (r: Row): Task => ({
  id: String(r.id),
  title: String(r.title),
  description: s(r.description),
  status: r.status as Task["status"],
  priority: Number(r.priority),
  due_date: s(r.due_date),
  due_at: s(r.due_at),
  planned_at: s(r.planned_at),
  completed_at: s(r.completed_at),
  archived_at: s(r.archived_at),
  version: Number(r.version),
  created_at: String(r.created_at),
  updated_at: String(r.updated_at),
});

export const toNote = (r: Row): Note => ({
  id: String(r.id),
  title: String(r.title),
  body: String(r.body),
  archived_at: s(r.archived_at),
  version: Number(r.version),
  created_at: String(r.created_at),
  updated_at: String(r.updated_at),
});

export const toAppointment = (r: Row): Appointment => ({
  id: String(r.id),
  title: String(r.title),
  starts_at: s(r.starts_at),
  ends_at: s(r.ends_at),
  local_date: s(r.local_date),
  timezone: String(r.timezone),
  all_day: Boolean(r.all_day),
  status: r.status as Appointment["status"],
  archived_at: s(r.archived_at),
  version: Number(r.version),
  created_at: String(r.created_at),
  updated_at: String(r.updated_at),
});

/* ---- shared helpers (callers run inside a transaction) ---- */

function getRow(ctx: Ctx, table: string, id: string): Row | undefined {
  return ctx.db.prepare(`SELECT * FROM ${table} WHERE id = ? AND owner_id = ?`).get(id, OWNER_ID) as
    | Row
    | undefined;
}

function requireRow(ctx: Ctx, table: string, id: string, label: string): Row {
  const row = getRow(ctx, table, id);
  if (!row) throw notFound(label);
  return row;
}

/**
 * Optimistic update: `WHERE id = ? AND version = ?`; zero rows is a 404 when
 * the row is missing and a 409 otherwise (docs/03 §5).
 */
function updateVersioned(
  ctx: Ctx,
  table: string,
  id: string,
  expectedVersion: number,
  label: string,
  set: Record<string, unknown>,
): Row {
  const cols = Object.keys(set);
  const sql = `UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(", ")}${cols.length ? ", " : ""}
    version = version + 1, updated_at = ? WHERE id = ? AND owner_id = ? AND version = ?`;
  const res = ctx.db
    .prepare(sql)
    .run(...(Object.values(set) as never[]), nowIso(ctx), id, OWNER_ID, expectedVersion);
  if (Number(res.changes) === 0) {
    if (!getRow(ctx, table, id)) throw notFound(label);
    throw versionConflict(label);
  }
  return requireRow(ctx, table, id, label);
}

export function linkSource(ctx: Ctx, entityType: string, entityId: string, source?: SourceRef): void {
  if (!source) return;
  const rev = ctx.db
    .prepare(
      `SELECT r.id FROM memo_revisions r JOIN memos m ON m.id = r.memo_id
       WHERE r.id = ? AND m.owner_id = ?`,
    )
    .get(source.memo_revision_id, OWNER_ID);
  if (!rev) throw new DomainError("UNPROCESSABLE_ENTITY", "Nguồn memo không tồn tại.", {
    "source.memo_revision_id": "Không tìm thấy bản memo.",
  });
  // An image quote must name an OCR run of an image of that same revision
  // (polymorphic link, validated here in the transaction: docs/03 §2).
  let attachmentId: string | null = null;
  if (source.ocr_run_id) {
    const run = ctx.db
      .prepare(
        `SELECT o.attachment_id FROM ocr_runs o JOIN attachments a ON a.id = o.attachment_id
         WHERE o.id = ? AND o.owner_id = ? AND a.memo_revision_id = ?`,
      )
      .get(source.ocr_run_id, OWNER_ID, source.memo_revision_id) as Row | undefined;
    if (!run) {
      throw new DomainError("UNPROCESSABLE_ENTITY", "Nguồn ảnh không thuộc bản memo này.", {
        "source.ocr_run_id": "Không tìm thấy bản OCR của ảnh trong memo.",
      });
    }
    attachmentId = String(run.attachment_id);
  }
  const now = nowIso(ctx);
  ctx.db
    .prepare(
      `INSERT INTO source_links
         (id, owner_id, entity_type, entity_id, memo_revision_id, attachment_id, ocr_run_id, quote, field_path,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      newId(),
      OWNER_ID,
      entityType,
      entityId,
      source.memo_revision_id,
      attachmentId,
      source.ocr_run_id ?? null,
      source.quote ?? null,
      ctx.auditSource ?? "manual",
      now,
      now,
    );
}

function listEntities<T>(
  ctx: Ctx,
  table: string,
  query: ListQuery,
  mapper: (r: Row) => T,
  extraWhere = "",
  statusColumn: string | null = null,
): Page<T> {
  const cursor = decodeCursor(query.cursor);
  const args: unknown[] = [OWNER_ID];
  let where = "owner_id = ? AND archived_at IS NULL";
  if (statusColumn && query.status) {
    where += ` AND ${statusColumn} = ?`;
    args.push(query.status);
  }
  if (extraWhere) where += ` AND ${extraWhere}`;
  if (cursor) {
    where += " AND (created_at < ? OR (created_at = ? AND id < ?))";
    args.push(cursor.createdAt, cursor.createdAt, cursor.id);
  }
  args.push(query.limit + 1);
  const rows = ctx.db
    .prepare(`SELECT * FROM ${table} WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ?`)
    .all(...(args as never[])) as Row[];
  const { rows: kept, next } = pageRows(rows, query.limit);
  return { items: kept.map(mapper), next_cursor: next };
}

/* ---- tasks ---- */

export function createTask(ctx: Ctx, input: TaskCreate): Task {
  const id = newId();
  const now = nowIso(ctx);
  ctx.db
    .prepare(
      `INSERT INTO tasks (id, owner_id, title, description, priority, due_date, due_at, planned_at,
         project_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      OWNER_ID,
      input.title,
      input.description ?? null,
      input.priority,
      input.due_date ?? null,
      input.due_at ?? null,
      input.planned_at ?? null,
      input.project_id ?? null,
      now,
      now,
    );
  linkSource(ctx, "task", id, input.source);
  const row = requireRow(ctx, "tasks", id, "Task");
  syncReminders(ctx, "task", row, { createDefault: input.default_reminder });
  writeAudit(ctx, { action: "task.create", entityType: "task", entityId: id, after: toTask(row) });
  return toTask(row);
}

export function getTask(ctx: Ctx, id: string): Task {
  return toTask(requireRow(ctx, "tasks", id, "Task"));
}

export const listTasks = (ctx: Ctx, q: ListQuery): Page<Task> =>
  listEntities(ctx, "tasks", q, toTask, "", "status");

export function patchTask(ctx: Ctx, id: string, input: TaskPatch): Task {
  const before = requireRow(ctx, "tasks", id, "Task");
  const { expected_version, ...fields } = input;
  const set: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) set[k] = v;
  // due_date / due_at stay mutually exclusive: setting one clears the other.
  if (set.due_date) set.due_at = null;
  if (set.due_at) set.due_date = null;
  if (set.status === "done") set.completed_at = nowIso(ctx);
  else if (set.status !== undefined) set.completed_at = null;
  if (set.status === "archived") set.archived_at = nowIso(ctx);
  const row = updateVersioned(ctx, "tasks", id, expected_version, "Task", set);
  syncReminders(ctx, "task", row, { createDefault: false });
  writeAudit(ctx, {
    action: "task.update",
    entityType: "task",
    entityId: id,
    before: toTask(before),
    after: toTask(row),
    versions: { from: expected_version, to: row.version },
  });
  return toTask(row);
}

export function setTaskDone(ctx: Ctx, id: string, expectedVersion: number, done: boolean): Task {
  const before = requireRow(ctx, "tasks", id, "Task");
  if (done && before.status === "done") {
    // Retried request: already complete, no second effect (A16 at M1 level).
    return toTask(before);
  }
  if (!done && before.status !== "done") {
    throw new DomainError("UNPROCESSABLE_ENTITY", "Task chưa hoàn thành nên không thể mở lại.");
  }
  const row = updateVersioned(ctx, "tasks", id, expectedVersion, "Task", {
    status: done ? "done" : "open",
    completed_at: done ? nowIso(ctx) : null,
  });
  syncReminders(ctx, "task", row, { createDefault: false });
  writeAudit(ctx, {
    action: done ? "task.complete" : "task.reopen",
    entityType: "task",
    entityId: id,
    before: toTask(before),
    after: toTask(row),
  });
  return toTask(row);
}

/* ---- notes ---- */

export function createNote(ctx: Ctx, input: NoteCreate): Note {
  const id = newId();
  const now = nowIso(ctx);
  ctx.db
    .prepare(
      "INSERT INTO notes (id, owner_id, title, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(id, OWNER_ID, input.title, input.body, now, now);
  linkSource(ctx, "note", id, input.source);
  const row = requireRow(ctx, "notes", id, "Ghi chú");
  writeAudit(ctx, { action: "note.create", entityType: "note", entityId: id, after: toNote(row) });
  return toNote(row);
}

export const getNote = (ctx: Ctx, id: string): Note => toNote(requireRow(ctx, "notes", id, "Ghi chú"));

export const listNotes = (ctx: Ctx, q: ListQuery): Page<Note> => listEntities(ctx, "notes", q, toNote);

export function patchNote(ctx: Ctx, id: string, input: NotePatch): Note {
  const before = requireRow(ctx, "notes", id, "Ghi chú");
  const set: Record<string, unknown> = {};
  if (input.title !== undefined) set.title = input.title;
  if (input.body !== undefined) set.body = input.body;
  const row = updateVersioned(ctx, "notes", id, input.expected_version, "Ghi chú", set);
  writeAudit(ctx, {
    action: "note.update",
    entityType: "note",
    entityId: id,
    before: toNote(before),
    after: toNote(row),
  });
  return toNote(row);
}

/* ---- appointments ---- */

export function createAppointment(ctx: Ctx, input: AppointmentCreate): Appointment {
  if (!assertValidTimeZone(input.timezone)) {
    throw new DomainError("BAD_REQUEST", "Dữ liệu không hợp lệ.", { timezone: "Múi giờ IANA không hợp lệ." });
  }
  const id = newId();
  const now = nowIso(ctx);
  ctx.db
    .prepare(
      `INSERT INTO appointments (id, owner_id, title, starts_at, local_date, ends_at, timezone, all_day,
         created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      OWNER_ID,
      input.title,
      input.all_day ? null : (input.starts_at ?? null),
      input.all_day ? (input.local_date ?? null) : null,
      input.ends_at ?? null,
      input.timezone,
      input.all_day ? 1 : 0,
      now,
      now,
    );
  linkSource(ctx, "appointment", id, input.source);
  const row = requireRow(ctx, "appointments", id, "Lịch hẹn");
  syncReminders(ctx, "appointment", row, { createDefault: input.default_reminder });
  writeAudit(ctx, {
    action: "appointment.create",
    entityType: "appointment",
    entityId: id,
    after: toAppointment(row),
  });
  return toAppointment(row);
}

export const getAppointment = (ctx: Ctx, id: string): Appointment =>
  toAppointment(requireRow(ctx, "appointments", id, "Lịch hẹn"));

export const listAppointments = (ctx: Ctx, q: ListQuery): Page<Appointment> =>
  listEntities(ctx, "appointments", q, toAppointment, "", "status");

export function patchAppointment(ctx: Ctx, id: string, input: AppointmentPatch): Appointment {
  const before = requireRow(ctx, "appointments", id, "Lịch hẹn");
  if (input.starts_at !== undefined && before.all_day) {
    throw new DomainError("UNPROCESSABLE_ENTITY", "Lịch cả ngày không có giờ bắt đầu.");
  }
  const set: Record<string, unknown> = {};
  if (input.title !== undefined) set.title = input.title;
  if (input.starts_at !== undefined) set.starts_at = input.starts_at;
  if (input.ends_at !== undefined) set.ends_at = input.ends_at;
  if (input.status !== undefined) {
    set.status = input.status;
    if (input.status === "archived") set.archived_at = nowIso(ctx);
  }
  const startsAt = (set.starts_at as string | undefined) ?? (before.starts_at as string | null);
  const endsAt = set.ends_at !== undefined ? (set.ends_at as string | null) : (before.ends_at as string | null);
  if (startsAt && endsAt && Date.parse(endsAt) < Date.parse(startsAt)) {
    throw new DomainError("BAD_REQUEST", "Dữ liệu không hợp lệ.", { ends_at: "ends_at không được trước starts_at." });
  }
  const row = updateVersioned(ctx, "appointments", id, input.expected_version, "Lịch hẹn", set);
  syncReminders(ctx, "appointment", row, { createDefault: false });
  writeAudit(ctx, {
    action: "appointment.update",
    entityType: "appointment",
    entityId: id,
    before: toAppointment(before),
    after: toAppointment(row),
  });
  return toAppointment(row);
}

/* ---- archive (docs/03 §4: user-confirmed, cancels future reminders) ---- */

export function archiveEntity(ctx: Ctx, type: string, id: string, expectedVersion: number): { id: string; version: number } {
  const table = { task: "tasks", note: "notes", appointment: "appointments", memo: "memos" }[type];
  if (!table) throw new DomainError("BAD_REQUEST", "Loại đối tượng không hợp lệ.", { type: "task|note|appointment|memo" });
  const before = requireRow(ctx, table, id, "Đối tượng");
  const set: Record<string, unknown> = { archived_at: nowIso(ctx) };
  if (type === "task") set.status = "archived";
  if (type === "appointment") set.status = "archived";
  const row = updateVersioned(ctx, table, id, expectedVersion, "Đối tượng", set);
  if (type === "task" || type === "appointment") syncReminders(ctx, type, row, { createDefault: false });
  writeAudit(ctx, { action: `${type}.archive`, entityType: type, entityId: id, before, after: row });
  return { id, version: Number(row.version) };
}
