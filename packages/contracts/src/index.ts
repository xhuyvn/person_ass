import { z } from "zod";

/* ------------------------------------------------------------------ */
/* Error contract (docs/03 §4)                                         */
/* ------------------------------------------------------------------ */

export const ApiErrorCode = z.enum([
  "BAD_REQUEST",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "PAYLOAD_TOO_LARGE",
  "UNPROCESSABLE_ENTITY",
  "RATE_LIMITED",
  "INTERNAL_ERROR",
]);

export type ApiErrorCode = z.infer<typeof ApiErrorCode>;

export const apiErrorStatusByCode: Record<ApiErrorCode, number> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNPROCESSABLE_ENTITY: 422,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
};

export const apiErrorSchema = z.object({
  error: z.object({
    code: ApiErrorCode,
    message: z.string(),
    field_errors: z.record(z.string(), z.string()).optional(),
    retryable: z.boolean(),
    correlation_id: z.string().min(1),
  }),
});

export type ApiError = z.infer<typeof apiErrorSchema>;

/* ------------------------------------------------------------------ */
/* Health contract (docs/02 §5)                                        */
/* ------------------------------------------------------------------ */

export const healthLiveSchema = z.object({
  status: z.literal("ok"),
  service: z.literal("personalass-server"),
  version: z.string(),
  uptime_s: z.number(),
  time: z.string(),
});

export type HealthLive = z.infer<typeof healthLiveSchema>;

export const healthReadySchema = z.object({
  status: z.enum(["ok", "degraded"]),
  checks: z.object({
    database: z.object({
      ok: z.boolean(),
      migrations_applied: z.number(),
      detail: z.string().optional(),
    }),
    data_dir: z.object({
      ok: z.boolean(),
      detail: z.string().optional(),
    }),
  }),
  time: z.string(),
});

export type HealthReady = z.infer<typeof healthReadySchema>;

/* ------------------------------------------------------------------ */
/* Pagination (docs/03 §4)                                             */
/* ------------------------------------------------------------------ */

export function paginationSchema<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    next_cursor: z.string().nullable().optional(),
  });
}

export type Pagination<T> = {
  items: z.infer<T>[];
  next_cursor?: string | null;
};

/* ------------------------------------------------------------------ */
/* Minimal DTO stubs (filled out per milestone)                        */
/* ------------------------------------------------------------------ */

export const baseEntityFields = {
  id: z.uuid(),
  version: z.number().int(),
  created_at: z.string(),
  updated_at: z.string(),
};

export const memoDtoSchema = z.object({
  ...baseEntityFields,
  owner_id: z.string(),
  current_revision_id: z.string().nullable().optional(),
  archived_at: z.string().nullable().optional(),
});

export type MemoDto = z.infer<typeof memoDtoSchema>;

export const taskDtoSchema = z.object({
  ...baseEntityFields,
  owner_id: z.string(),
  title: z.string(),
  description: z.string().nullable().optional(),
  status: z.enum(["open", "in_progress", "waiting", "done", "archived"]),
  // Range must stay in sync with the tasks.priority CHECK constraint
  // (migrations/0001_core.sql: priority BETWEEN 0 AND 4).
  priority: z.number().int().min(0).max(4),
  project_id: z.string().nullable().optional(),
  due_date: z.string().nullable().optional(),
  due_at: z.string().nullable().optional(),
});

export type TaskDto = z.infer<typeof taskDtoSchema>;

export const appointmentDtoSchema = z.object({
  ...baseEntityFields,
  owner_id: z.string(),
  title: z.string(),
  starts_at: z.string().nullable().optional(),
  local_date: z.string().nullable().optional(),
  ends_at: z.string().nullable().optional(),
  timezone: z.string(),
  all_day: z.boolean(),
  status: z.enum(["scheduled", "done", "cancelled", "archived"]),
  project_id: z.string().nullable().optional(),
});

export type AppointmentDto = z.infer<typeof appointmentDtoSchema>;


/* M1 manual slice contracts (docs/03 §4). Request schemas are the runtime
 * source of truth for the server and for the generated OpenAPI document. */

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");
const isoInstant = z.iso.datetime({ offset: true });
const uuid = z.uuid();
const expectedVersion = z.number().int().min(1);

export const ENTITY_TYPES = ["task", "note", "appointment", "memo"] as const;
export const entityTypeSchema = z.enum(ENTITY_TYPES);
export type EntityType = z.infer<typeof entityTypeSchema>;

/* ---- memos ---- */

export const memoCreateSchema = z.object({
  client_request_id: uuid,
  text: z.string().trim().min(1).max(20000),
  captured_at: isoInstant,
  timezone: z.string().min(1).default("Asia/Ho_Chi_Minh"),
});
export type MemoCreate = z.infer<typeof memoCreateSchema>;

export const memoReceiptSchema = z.object({
  memo_id: uuid,
  revision_id: uuid,
  job_id: z.null(),
  state: z.literal("saved"),
});
export type MemoReceipt = z.infer<typeof memoReceiptSchema>;

export const memoRevisionSchema = z.object({
  id: uuid,
  revision_no: z.number().int(),
  raw_text: z.string(),
  captured_at: z.string(),
  timezone: z.string(),
  input_kind: z.string(),
});

export const memoDetailSchema = z.object({
  id: uuid,
  current_revision_id: z.string().nullable(),
  archived_at: z.string().nullable(),
  version: z.number().int(),
  created_at: z.string(),
  updated_at: z.string(),
  revision: memoRevisionSchema.nullable(),
  /** Entities created manually from this memo (source links). */
  sources: z.array(
    z.object({
      entity_type: z.string(),
      entity_id: z.string(),
      memo_revision_id: z.string().nullable(),
      quote: z.string().nullable(),
    }),
  ),
});
export type MemoDetail = z.infer<typeof memoDetailSchema>;

/* ---- source link (manual provenance) ---- */

export const sourceRefSchema = z.object({
  memo_revision_id: uuid,
  quote: z.string().max(2000).optional(),
});
export type SourceRef = z.infer<typeof sourceRefSchema>;

/* ---- tasks ---- */

export const taskStatusSchema = z.enum(["open", "in_progress", "waiting", "done", "archived"]);

export const taskCreateSchema = z
  .object({
    title: z.string().trim().min(1).max(300),
    description: z.string().max(10000).nullish(),
    priority: z.number().int().min(0).max(4).default(0),
    due_date: dateOnly.nullish(),
    due_at: isoInstant.nullish(),
    planned_at: isoInstant.nullish(),
    project_id: uuid.nullish(),
    source: sourceRefSchema.optional(),
    /** Opt out of the default reminder (docs/00 B). */
    default_reminder: z.boolean().default(true),
  })
  .refine((v) => !(v.due_date && v.due_at), {
    message: "due_date and due_at are mutually exclusive",
    path: ["due_at"],
  });
export type TaskCreate = z.infer<typeof taskCreateSchema>;

export const taskPatchSchema = z
  .object({
    expected_version: expectedVersion,
    title: z.string().trim().min(1).max(300).optional(),
    description: z.string().max(10000).nullable().optional(),
    status: taskStatusSchema.optional(),
    priority: z.number().int().min(0).max(4).optional(),
    due_date: dateOnly.nullable().optional(),
    due_at: isoInstant.nullable().optional(),
    planned_at: isoInstant.nullable().optional(),
  })
  .refine((v) => !(v.due_date && v.due_at), {
    message: "due_date and due_at are mutually exclusive",
    path: ["due_at"],
  });
export type TaskPatch = z.infer<typeof taskPatchSchema>;

export const versionedActionSchema = z.object({ expected_version: expectedVersion });
export type VersionedAction = z.infer<typeof versionedActionSchema>;

export const taskSchema = z.object({
  id: uuid,
  title: z.string(),
  description: z.string().nullable(),
  status: taskStatusSchema,
  priority: z.number().int(),
  due_date: z.string().nullable(),
  due_at: z.string().nullable(),
  planned_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  archived_at: z.string().nullable(),
  version: z.number().int(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type Task = z.infer<typeof taskSchema>;

/* ---- notes ---- */

export const noteCreateSchema = z.object({
  title: z.string().trim().min(1).max(300),
  body: z.string().max(50000).default(""),
  source: sourceRefSchema.optional(),
});
export type NoteCreate = z.infer<typeof noteCreateSchema>;

export const notePatchSchema = z.object({
  expected_version: expectedVersion,
  title: z.string().trim().min(1).max(300).optional(),
  body: z.string().max(50000).optional(),
});
export type NotePatch = z.infer<typeof notePatchSchema>;

export const noteSchema = z.object({
  id: uuid,
  title: z.string(),
  body: z.string(),
  archived_at: z.string().nullable(),
  version: z.number().int(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type Note = z.infer<typeof noteSchema>;

/* ---- appointments ---- */

const appointmentFields = {
  title: z.string().trim().min(1).max(300),
  timezone: z.string().min(1).default("Asia/Ho_Chi_Minh"),
  starts_at: isoInstant.nullish(),
  ends_at: isoInstant.nullish(),
  local_date: dateOnly.nullish(),
  all_day: z.boolean().default(false),
};

export const appointmentCreateSchema = z
  .object({
    ...appointmentFields,
    source: sourceRefSchema.optional(),
    default_reminder: z.boolean().default(true),
  })
  .superRefine((v, ctx) => {
    if (v.all_day) {
      if (!v.local_date) ctx.addIssue({ code: "custom", path: ["local_date"], message: "all_day requires local_date" });
      if (v.starts_at) ctx.addIssue({ code: "custom", path: ["starts_at"], message: "all_day must not set starts_at" });
    } else {
      if (!v.starts_at) ctx.addIssue({ code: "custom", path: ["starts_at"], message: "timed appointment requires starts_at" });
      if (v.local_date) ctx.addIssue({ code: "custom", path: ["local_date"], message: "timed appointment must not set local_date" });
    }
    if (v.starts_at && v.ends_at && Date.parse(v.ends_at) < Date.parse(v.starts_at)) {
      ctx.addIssue({ code: "custom", path: ["ends_at"], message: "ends_at must not precede starts_at" });
    }
  });
export type AppointmentCreate = z.infer<typeof appointmentCreateSchema>;

export const appointmentPatchSchema = z.object({
  expected_version: expectedVersion,
  title: z.string().trim().min(1).max(300).optional(),
  starts_at: isoInstant.optional(),
  ends_at: isoInstant.nullable().optional(),
  status: z.enum(["scheduled", "done", "cancelled", "archived"]).optional(),
});
export type AppointmentPatch = z.infer<typeof appointmentPatchSchema>;

export const appointmentSchema = z.object({
  id: uuid,
  title: z.string(),
  starts_at: z.string().nullable(),
  ends_at: z.string().nullable(),
  local_date: z.string().nullable(),
  timezone: z.string(),
  all_day: z.boolean(),
  status: z.enum(["scheduled", "done", "cancelled", "archived"]),
  archived_at: z.string().nullable(),
  version: z.number().int(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type Appointment = z.infer<typeof appointmentSchema>;

/* ---- reminders ---- */

export const reminderRuleCreateSchema = z.object({
  entity_type: z.enum(["task", "appointment"]),
  entity_id: uuid,
  /** Minutes before (negative) or after (positive) the anchor. */
  offset_minutes: z.number().int().min(-525600).max(525600).default(0),
  /** Only for date-only anchors, HH:MM local. */
  local_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
});
export type ReminderRuleCreate = z.infer<typeof reminderRuleCreateSchema>;

export const reminderRuleSchema = z.object({
  id: uuid,
  entity_type: z.string(),
  entity_id: z.string(),
  anchor: z.string(),
  offset_minutes: z.number().int(),
  local_time: z.string().nullable(),
  enabled: z.boolean(),
  schedule_revision: z.number().int(),
  version: z.number().int(),
  next_at: z.string().nullable(),
});
export type ReminderRule = z.infer<typeof reminderRuleSchema>;

/* ---- notifications ---- */

export const notificationSchema = z.object({
  id: uuid,
  kind: z.enum(["reminder", "digest"]),
  title: z.string(),
  body: z.string(),
  entity_type: z.string().nullable(),
  entity_id: z.string().nullable(),
  scheduled_at: z.string().nullable(),
  state: z.enum(["created", "delivered", "acknowledged"]),
  created_at: z.string(),
  acknowledged_at: z.string().nullable(),
});
export type Notification = z.infer<typeof notificationSchema>;

export const snoozeSchema = z.object({
  minutes: z.number().int().min(1).max(10080),
});
export type Snooze = z.infer<typeof snoozeSchema>;

/* ---- listing ---- */

export const listQuerySchema = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  status: z.string().max(40).optional(),
  unread: z.enum(["true", "false"]).optional(),
});
export type ListQuery = z.infer<typeof listQuerySchema>;
