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
