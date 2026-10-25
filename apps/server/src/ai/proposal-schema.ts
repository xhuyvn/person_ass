import { z } from "zod";

/**
 * Proposal v1 envelope (examples/proposal.schema.json) as Zod. Unknown keys
 * and unknown operations are rejected (docs/04 §3). The envelope does not
 * replace the per-entity field validation done by the policy step.
 */
const evidenceSchema = z
  .object({
    source_id: z.string().min(1),
    quote: z.string().min(1).max(2000),
    field_path: z.string().nullable().optional(),
  })
  .strict();

const ambiguitySchema = z
  .object({
    field_path: z.string().max(100),
    reason: z.string().max(200),
    question: z.string().max(500),
  })
  .strict();

export const proposalActionInputSchema = z
  .object({
    action_id: z.string().min(1).max(64),
    operation: z.enum(["create", "update", "request_confirmation"]),
    entity_type: z.enum(["task", "appointment", "note", "person", "asset", "interaction", "maintenance_record"]),
    target_id: z.string().max(64).nullable(),
    expected_version: z.number().int().min(1).nullable(),
    fields: z.record(z.string(), z.unknown()),
    evidence: z.array(evidenceSchema).min(1).max(10),
    ambiguity: z.array(ambiguitySchema).max(10),
    depends_on: z.array(z.string().max(64)).max(10),
  })
  .strict();
export type ProposalActionInput = z.infer<typeof proposalActionInputSchema>;

export const proposalEnvelopeSchema = z
  .object({
    schema_version: z.literal("1.0"),
    source_revision_id: z.string().min(1),
    actions: z.array(proposalActionInputSchema).max(50),
  })
  .strict();
export type ProposalEnvelope = z.infer<typeof proposalEnvelopeSchema>;

/* ---- per-entity field schemas (deep validation, docs/04 §3) ---- */

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const instant = z.iso.datetime({ offset: true });
const title = z.string().trim().min(1).max(300);

export const aiTaskCreateFields = z
  .object({
    title,
    description: z.string().max(5000).nullable().optional(),
    // Waiting-on-person needs people resolution (M4); only open tasks here.
    status: z.literal("open").optional(),
    priority: z.number().int().min(0).max(4).optional(),
    due_date: dateOnly.nullable().optional(),
    due_at: instant.nullable().optional(),
    planned_at: instant.nullable().optional(),
    category_id: z.null().optional(),
  })
  .strict()
  .refine((v) => !(v.due_date && v.due_at), { message: "due_date và due_at loại trừ nhau", path: ["due_at"] });

export const aiAppointmentCreateFields = z
  .object({
    title,
    starts_at: instant.nullable().optional(),
    ends_at: instant.nullable().optional(),
    all_day: z.boolean().optional(),
    local_date: dateOnly.nullable().optional(),
    category_id: z.null().optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.all_day) {
      if (!v.local_date) ctx.addIssue({ code: "custom", path: ["local_date"], message: "Thiếu ngày" });
    } else if (!v.starts_at) {
      ctx.addIssue({ code: "custom", path: ["starts_at"], message: "Thiếu giờ bắt đầu" });
    }
    if (v.starts_at && v.ends_at && Date.parse(v.ends_at) < Date.parse(v.starts_at)) {
      ctx.addIssue({ code: "custom", path: ["ends_at"], message: "ends_at trước starts_at" });
    }
  });

export const aiNoteCreateFields = z
  .object({ title, body: z.string().max(20000).optional(), category_id: z.null().optional() })
  .strict();

export const aiTaskUpdateFields = z
  .object({
    title: title.optional(),
    description: z.string().max(5000).nullable().optional(),
    due_date: dateOnly.nullable().optional(),
    due_at: instant.nullable().optional(),
    planned_at: instant.nullable().optional(),
    /** Status changes are allowed only after explicit confirmation. */
    status: z.enum(["done", "archived"]).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "Không có trường nào để cập nhật" })
  .refine((v) => !(v.due_date && v.due_at), { message: "due_date và due_at loại trừ nhau", path: ["due_at"] });

export const aiAppointmentUpdateFields = z
  .object({
    title: title.optional(),
    starts_at: instant.optional(),
    ends_at: instant.nullable().optional(),
    status: z.enum(["cancelled", "done"]).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "Không có trường nào để cập nhật" });

/** JSON Schema handed to providers that support native structured output. */
export const proposalJsonSchema = z.toJSONSchema(proposalEnvelopeSchema) as Record<string, unknown>;
