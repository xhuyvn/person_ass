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

/** Upper bound of images per memo; the server limit (MAX_IMAGES_PER_MEMO) may be lower. */
export const MAX_ATTACHMENTS_PER_MEMO = 10;

export const memoCreateSchema = z
  .object({
    client_request_id: uuid,
    /** May be empty when the memo is images only. */
    text: z.string().trim().max(20000).default(""),
    /** M3: tokens from POST /attachments, in display order. */
    attachment_tokens: z.array(z.string().min(16).max(200)).max(MAX_ATTACHMENTS_PER_MEMO).default([]),
    captured_at: isoInstant,
    timezone: z.string().min(1).default("Asia/Ho_Chi_Minh"),
    /** M2: queue AI processing after the memo is durably saved. */
    process: z.boolean().default(true),
    /** local_only memos are never sent to a cloud connection (docs/04 §6, A20). */
    privacy: z.enum(["default", "local_only"]).default("default"),
  })
  .refine((v) => v.text.length > 0 || v.attachment_tokens.length > 0, {
    message: "Nhập nội dung hoặc đính kèm ít nhất một ảnh.",
    path: ["text"],
  })
  .refine((v) => new Set(v.attachment_tokens).size === v.attachment_tokens.length, {
    message: "Ảnh bị gửi trùng.",
    path: ["attachment_tokens"],
  });
export type MemoCreate = z.infer<typeof memoCreateSchema>;

/* ---- attachments and OCR (M3) ---- */

export const ATTACHMENT_MIMES = ["image/jpeg", "image/png", "image/webp"] as const;

/** POST /attachments (multipart, field "file") → staged upload, no job yet (docs/03 §4). */
export const attachmentUploadReceiptSchema = z.object({
  attachment_id: uuid,
  /** Opaque, short-lived; pass it in memo create. Never logged. */
  attachment_token: z.string(),
  expires_at: z.string(),
  mime: z.enum(ATTACHMENT_MIMES),
  bytes: z.number().int(),
  width: z.number().int(),
  height: z.number().int(),
  sha256: z.string(),
});
export type AttachmentUploadReceipt = z.infer<typeof attachmentUploadReceiptSchema>;

export const ocrBlockSchema = z.object({
  text: z.string(),
  kind: z.enum(["paragraph", "table", "heading", "other"]),
  uncertain: z.boolean(),
});
export const ocrUncertaintySchema = z.object({
  fragment: z.string(),
  reason: z.string(),
  alternatives: z.array(z.string()),
});
export type OcrUncertainty = z.infer<typeof ocrUncertaintySchema>;

/** One immutable OCR result: from the OCR model (author ai) or a user correction (author user). */
export const ocrRunSchema = z.object({
  id: uuid,
  attachment_id: uuid,
  author: z.enum(["ai", "user"]),
  status: z.enum(["readable", "partial", "unreadable"]),
  text: z.string(),
  blocks: z.array(ocrBlockSchema),
  uncertainties: z.array(ocrUncertaintySchema),
  model_id: z.string().nullable(),
  supersedes_run_id: z.string().nullable(),
  created_at: z.string(),
});
export type OcrRun = z.infer<typeof ocrRunSchema>;

export const attachmentSchema = z.object({
  id: uuid,
  position: z.number().int(),
  mime: z.enum(ATTACHMENT_MIMES),
  bytes: z.number().int(),
  width: z.number().int(),
  height: z.number().int(),
  /** Relative API path of the original image, e.g. /api/v1/attachments/<id>/content. */
  content_path: z.string(),
  /** Effective OCR result (newest run); null = not read yet. */
  ocr: ocrRunSchema.nullable(),
});
export type Attachment = z.infer<typeof attachmentSchema>;

/** POST /attachments/:id/ocr-corrections: the user's corrected text becomes a new run. */
export const ocrCorrectionSchema = z.object({
  text: z.string().trim().min(1).max(50000),
  /** The run the user was looking at; 409 if a newer run exists. Null when none existed. */
  expected_run_id: uuid.nullable(),
  /** Queue a reprocess of the memo with the corrected text (default true). */
  reprocess: z.boolean().default(true),
});
export type OcrCorrection = z.infer<typeof ocrCorrectionSchema>;

export const memoReceiptSchema = z.object({
  memo_id: uuid,
  revision_id: uuid,
  job_id: uuid.nullable(),
  /** "saved" = stored without AI processing; "queued" = a job was created. */
  state: z.enum(["saved", "queued"]),
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
      /** Set when the quote comes from an image: the attachment and the exact OCR run quoted. */
      attachment_id: z.string().nullable(),
      ocr_run_id: z.string().nullable(),
    }),
  ),
  /** Images of the current revision, in order (M3). */
  attachments: z.array(z.lazy(() => attachmentSchema)),
  privacy: z.enum(["default", "local_only"]),
  /** Latest processing job of the current revision (null = never processed). */
  job: z.lazy(() => jobSchema).nullable(),
  /** Actions of every proposal made from this memo, newest first. */
  actions: z.array(z.lazy(() => proposalActionSchema)),
  clarifications: z.array(z.lazy(() => clarificationSchema)),
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

/* ------------------------------------------------------------------ */
/* M2 — AI text: connections, roles, jobs, proposals (docs/03, docs/04) */
/* ------------------------------------------------------------------ */

export const AI_CONNECTION_KINDS = ["openrouter", "ollama_local", "ollama_cloud", "custom_openai"] as const;
export const aiConnectionKindSchema = z.enum(AI_CONNECTION_KINDS);
export type AiConnectionKind = z.infer<typeof aiConnectionKindSchema>;

export const AI_ROLES = ["information", "ocr", "assistant"] as const;
export const aiRoleSchema = z.enum(AI_ROLES);
export type AiRole = z.infer<typeof aiRoleSchema>;

/**
 * How to ask for JSON: "auto" tries native json_schema and falls back to a
 * plain JSON instruction when the endpoint rejects it (docs/04 §8).
 */
export const structuredOutputSchema = z.enum(["auto", "json_schema", "json_object", "none"]);
export type StructuredOutput = z.infer<typeof structuredOutputSchema>;

const baseUrl = z.string().trim().min(1).max(500);
const apiKey = z.string().trim().min(1).max(4096);
const timeoutMs = z.number().int().min(1000).max(900000);

export const aiConnectionCreateSchema = z.object({
  name: z.string().trim().min(1).max(100),
  kind: aiConnectionKindSchema,
  base_url: baseUrl,
  /** Write-only: stored encrypted, never returned. */
  api_key: apiKey.optional(),
  /** Declared by the owner; a LAN URL is not automatically "local" (docs/04 §6). */
  privacy_scope: z.enum(["local", "cloud"]),
  enabled: z.boolean().default(true),
  timeout_ms: timeoutMs.default(120000),
  structured_output: structuredOutputSchema.default("auto"),
});
export type AiConnectionCreate = z.infer<typeof aiConnectionCreateSchema>;

export const aiConnectionPatchSchema = z.object({
  expected_version: expectedVersion,
  name: z.string().trim().min(1).max(100).optional(),
  base_url: baseUrl.optional(),
  /** A new key replaces the old one; an empty value never clears it. */
  api_key: apiKey.optional(),
  clear_api_key: z.literal(true).optional(),
  privacy_scope: z.enum(["local", "cloud"]).optional(),
  enabled: z.boolean().optional(),
  timeout_ms: timeoutMs.optional(),
  structured_output: structuredOutputSchema.optional(),
});
export type AiConnectionPatch = z.infer<typeof aiConnectionPatchSchema>;

export const aiConnectionSchema = z.object({
  id: uuid,
  name: z.string(),
  kind: aiConnectionKindSchema,
  base_url: z.string(),
  privacy_scope: z.enum(["local", "cloud"]),
  enabled: z.boolean(),
  key_configured: z.boolean(),
  /** Masked hint such as "…a1b2"; never the key. */
  key_label: z.string().nullable(),
  timeout_ms: z.number().int(),
  structured_output: structuredOutputSchema,
  version: z.number().int(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type AiConnection = z.infer<typeof aiConnectionSchema>;
export const aiConnectionListSchema = z.object({ items: z.array(aiConnectionSchema) });

export const PROVIDER_ERROR_CODES = [
  "auth",
  "rate_limited",
  "unavailable",
  "timeout",
  "model_not_found",
  "bad_request",
  "blocked_by_policy",
  "invalid_response",
  "not_configured",
  /** The model rejected image input (text-only model bound to the OCR role). */
  "no_image_input",
] as const;

export const providerErrorSchema = z.object({
  code: z.enum(PROVIDER_ERROR_CODES),
  message: z.string(),
});
export type ProviderErrorDto = z.infer<typeof providerErrorSchema>;

/** Test without saving anything (docs/03 §4). */
export const aiConnectionTestSchema = z.object({
  kind: z.enum(["metadata", "text", "image"]),
  model_id: z.string().trim().min(1).max(200).optional(),
});
export type AiConnectionTest = z.infer<typeof aiConnectionTestSchema>;

export const aiConnectionTestResultSchema = z.object({
  ok: z.boolean(),
  kind: z.enum(["metadata", "text", "image"]),
  latency_ms: z.number().int().nullable(),
  models_count: z.number().int().nullable(),
  sample: z.string().nullable(),
  error: providerErrorSchema.nullable(),
});
export type AiConnectionTestResult = z.infer<typeof aiConnectionTestResultSchema>;

const capability = z.enum(["yes", "no", "unknown"]);
export const aiModelSchema = z.object({
  id: z.string(),
  capabilities: z.object({ image_input: capability, json_schema: capability, tools: capability }),
});
export type AiModel = z.infer<typeof aiModelSchema>;

export const aiModelListSchema = z.object({
  items: z.array(aiModelSchema),
  error: providerErrorSchema.nullable(),
  /** The model id can always be typed by hand (docs/04 §1). */
  manual_allowed: z.literal(true),
});
export type AiModelList = z.infer<typeof aiModelListSchema>;

const modelRef = z.object({ connection_id: uuid, model_id: z.string().trim().min(1).max(200) });

export const aiRoleBindingInputSchema = z.object({
  role: aiRoleSchema,
  connection_id: uuid,
  model_id: z.string().trim().min(1).max(200),
  max_tokens: z.number().int().min(64).max(32768).default(2048),
  temperature: z.number().min(0).max(2).nullable().default(0.1),
  fallback: z
    .object({
      bindings: z.array(modelRef).max(3).default([]),
      /** Fallback may only reach a cloud connection when explicitly allowed. */
      allow_cloud: z.boolean().default(false),
    })
    .default({ bindings: [], allow_cloud: false }),
});
export type AiRoleBindingInput = z.infer<typeof aiRoleBindingInputSchema>;

export const aiRolesPutSchema = z.object({ roles: z.array(aiRoleBindingInputSchema).min(1).max(3) });
export type AiRolesPut = z.infer<typeof aiRolesPutSchema>;

export const aiRoleBindingSchema = z.object({
  role: aiRoleSchema,
  connection_id: uuid,
  model_id: z.string(),
  max_tokens: z.number().int(),
  temperature: z.number().nullable(),
  fallback: z.object({ bindings: z.array(modelRef), allow_cloud: z.boolean() }),
  version: z.number().int(),
  updated_at: z.string(),
});
export type AiRoleBinding = z.infer<typeof aiRoleBindingSchema>;
export const aiRoleListSchema = z.object({ items: z.array(aiRoleBindingSchema) });

/* ---- jobs ---- */

export const JOB_STATES = [
  "queued",
  "running",
  "retry_wait",
  "waiting_configuration",
  "succeeded",
  "failed",
  "cancelled",
] as const;
export type JobState = (typeof JOB_STATES)[number];

export const jobSchema = z.object({
  id: uuid,
  kind: z.literal("process_memo"),
  memo_revision_id: uuid,
  state: z.enum(JOB_STATES),
  attempt: z.number().int(),
  max_attempts: z.number().int(),
  run_after: z.string(),
  /** Secret-free error summary. */
  error_code: z.string().nullable(),
  error_message: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type Job = z.infer<typeof jobSchema>;

/* ---- proposals, clarifications, undo ---- */

export const PROPOSAL_ACTION_STATUSES = [
  "applied",
  "needs_clarification",
  "waiting_dependency",
  "rejected",
  "duplicate",
  "dismissed",
] as const;
export type ProposalActionStatus = (typeof PROPOSAL_ACTION_STATUSES)[number];

export const proposalActionSchema = z.object({
  id: uuid,
  proposal_id: uuid,
  operation: z.string(),
  entity_type: z.string(),
  target_id: z.string().nullable(),
  status: z.enum(PROPOSAL_ACTION_STATUSES),
  reason: z.string().nullable(),
  fields: z.record(z.string(), z.unknown()),
  /** ocr_run_id is set when the quote was taken from an image (M3). */
  evidence: z.array(z.object({ quote: z.string(), ocr_run_id: z.string().nullable() })),
  result_entity_type: z.string().nullable(),
  result_entity_id: z.string().nullable(),
  action_group_id: z.string().nullable(),
  created_at: z.string(),
});
export type ProposalAction = z.infer<typeof proposalActionSchema>;

export const CLARIFICATION_KINDS = ["missing_fields", "choose_target", "confirm", "revalidate"] as const;
export type ClarificationKind = (typeof CLARIFICATION_KINDS)[number];

export const clarificationSchema = z.object({
  id: uuid,
  proposal_action_id: uuid,
  kind: z.enum(CLARIFICATION_KINDS),
  field_path: z.string().nullable(),
  question: z.string(),
  options: z.array(z.object({ value: z.string(), label: z.string() })),
  state: z.enum(["open", "answered", "dismissed"]),
  version: z.number().int(),
  created_at: z.string(),
});
export type Clarification = z.infer<typeof clarificationSchema>;

export const clarificationAnswerSchema = z.object({
  expected_version: expectedVersion,
  answer: z.union([
    /** Supply the missing/uncertain fields, e.g. {starts_at}. */
    z.object({ fields: z.record(z.string(), z.unknown()) }).strict(),
    /** Pick one of the offered targets (choose_target). */
    z.object({ choice: z.string().min(1).max(100) }).strict(),
    /** Confirm a change that needs explicit consent (confirm/revalidate). */
    z.object({ confirm: z.literal(true) }).strict(),
    /** Drop this action; nothing is created. */
    z.object({ dismiss: z.literal(true) }).strict(),
  ]),
});
export type ClarificationAnswer = z.infer<typeof clarificationAnswerSchema>;

export const clarificationResultSchema = z.object({
  clarification: clarificationSchema,
  action: proposalActionSchema,
});
export type ClarificationResult = z.infer<typeof clarificationResultSchema>;

export const undoResultSchema = z.object({
  action_group_id: uuid,
  state: z.literal("undone"),
  reverted: z.array(z.object({ entity_type: z.string(), entity_id: z.string() })),
});
export type UndoResult = z.infer<typeof undoResultSchema>;

export const auditEventSchema = z.object({
  id: uuid,
  actor: z.enum(["user", "ai", "system"]),
  action: z.string(),
  entity_type: z.string().nullable(),
  entity_id: z.string().nullable(),
  action_group_id: z.string().nullable(),
  before: z.unknown(),
  after: z.unknown(),
  source: z.string().nullable(),
  created_at: z.string(),
});
export type AuditEvent = z.infer<typeof auditEventSchema>;
