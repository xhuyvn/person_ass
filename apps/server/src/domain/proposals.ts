import { createHash } from "node:crypto";
import type { z } from "zod";
import {
  appointmentCreateSchema,
  appointmentPatchSchema,
  noteCreateSchema,
  taskCreateSchema,
  taskPatchSchema,
  type Clarification,
  type ClarificationAnswer,
  type ClarificationKind,
  type ClarificationResult,
  type ProposalAction,
  type ProposalActionStatus,
  type UndoResult,
} from "@personalass/contracts";
import {
  aiAppointmentCreateFields,
  aiAppointmentUpdateFields,
  aiNoteCreateFields,
  aiTaskCreateFields,
  aiTaskUpdateFields,
  proposalEnvelopeSchema,
  type ProposalActionInput,
  type ProposalEnvelope,
} from "../ai/proposal-schema.js";
import type { Candidate } from "../ai/prompt.js";
import { transaction } from "../db/open.js";
import {
  DomainError,
  OWNER_ID,
  newId,
  notFound,
  nowIso,
  versionConflict,
  type Ctx,
  type Row,
} from "./core.js";
import * as entities from "./entities.js";

/* ------------------------------------------------------------------ */
/* Parsing model output (docs/04 §8: validate, never patch with regex)  */
/* ------------------------------------------------------------------ */

export type ParseResult = { ok: true; proposal: ProposalEnvelope } | { ok: false; problems: string[] };

export function parseModelOutput(text: string, revisionId: string): ParseResult {
  let body = text.trim();
  // A single surrounding markdown fence is unwrapped; the content is still
  // validated in full, nothing inside it is repaired.
  const fence = /^```(?:json)?\s*\n([\s\S]*)\n```$/i.exec(body);
  if (fence) body = (fence[1] as string).trim();
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return { ok: false, problems: ["Kết quả không phải JSON hợp lệ."] };
  }
  const parsed = proposalEnvelopeSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      problems: parsed.error.issues.slice(0, 20).map((i) => `${i.path.join(".") || "(gốc)"}: ${i.message}`),
    };
  }
  const problems: string[] = [];
  if (parsed.data.source_revision_id !== revisionId) problems.push("source_revision_id không khớp nguồn được cung cấp.");
  const ids = new Set<string>();
  for (const a of parsed.data.actions) {
    if (ids.has(a.action_id)) problems.push(`action_id trùng: ${a.action_id}`);
    ids.add(a.action_id);
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, proposal: parsed.data };
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const normalizeText = (s: string): string => s.normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (v !== undefined) out[k] = canonical(v);
    }
    return out;
  }
  return typeof value === "string" ? value.normalize("NFC").trim() : value;
}

/**
 * Durable action key computed by the backend from operation + target +
 * evidence span + normalized payload; the model's action_id is never used
 * (docs/03 §5, docs/04 §6).
 */
export function stableActionKey(a: ProposalActionInput): string {
  const quotes = a.evidence.map((e) => normalizeText(e.quote)).sort();
  return createHash("sha256")
    .update(JSON.stringify([a.operation, a.entity_type, a.target_id ?? null, quotes, canonical(a.fields)]))
    .digest("hex");
}

function zodProblems(err: z.ZodError): string {
  return err.issues
    .slice(0, 5)
    .map((i) => `${i.path.join(".") || "fields"}: ${i.message}`)
    .join("; ");
}

const TABLE: Record<string, string> = { task: "tasks", appointment: "appointments", note: "notes" };

function loadTarget(ctx: Ctx, type: string, id: string): Row | undefined {
  const table = TABLE[type];
  if (!table) return undefined;
  return ctx.db.prepare(`SELECT * FROM ${table} WHERE id = ? AND owner_id = ?`).get(id, OWNER_ID) as Row | undefined;
}

function candidateLabel(c: Candidate): string {
  const when = c.starts_at ?? c.due_at ?? c.local_date ?? c.due_date ?? null;
  return when ? `${c.title} (${when})` : c.title;
}

/* ------------------------------------------------------------------ */
/* Policy (docs/04 §4)                                                 */
/* ------------------------------------------------------------------ */

type Plan =
  | { kind: "create_task"; input: z.output<typeof taskCreateSchema> }
  | { kind: "create_appointment"; input: z.output<typeof appointmentCreateSchema> }
  | { kind: "create_note"; input: z.output<typeof noteCreateSchema> }
  | { kind: "update_task"; id: string; fields: Record<string, unknown> }
  | { kind: "update_appointment"; id: string; fields: Record<string, unknown> };

type Decision =
  | { kind: "apply"; plan: Plan }
  | { kind: "clarify"; clarKind: ClarificationKind; fieldPath: string | null; question: string; options: Array<{ value: string; label: string }>; reason: string }
  | { kind: "reject"; reason: string }
  | { kind: "wait"; reason: string };

/** Effective OCR text of one image, as the information model saw it (M3). */
export type OcrEvidenceSource = {
  runId: string;
  imagePosition: number;
  text: string;
  /** Uncertain fragments and uncertain blocks of that run, with any alternatives. */
  uncertain: Array<{ fragment: string; alternatives: string[] }>;
};

export type RevisionInfo = { id: string; memoId: string; text: string; timezone: string; ocr?: OcrEvidenceSource[] };

type ActionShape = Pick<ProposalActionInput, "operation" | "entity_type" | "target_id" | "expected_version" | "fields" | "evidence">;

/**
 * Source link for an AI change. A quote taken from an image points at the
 * exact OCR run it came from (docs/03 §3), never at "the latest OCR".
 */
function sourceOf(rev: RevisionInfo, a: ActionShape) {
  const fromImage = a.evidence.find((e) => e.source_id !== rev.id);
  return {
    memo_revision_id: rev.id,
    quote: a.evidence.map((e) => e.quote).join(" … ").slice(0, 2000),
    ...(fromImage ? { ocr_run_id: fromImage.source_id } : {}),
  };
}

const TIME_FIELDS = ["starts_at", "ends_at", "local_date", "due_date", "due_at", "planned_at"] as const;

/** Patterns a day/month of `value` would be written as in Vietnamese text (12/11, 12-11, ngày 12 tháng 11). */
function dayMonthPatterns(value: string, timeZone: string): RegExp[] {
  let ymd: string | null = /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
  if (!ymd && !Number.isNaN(Date.parse(value))) {
    ymd = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value));
  }
  if (!ymd) return [];
  const d = Number(ymd.slice(8, 10));
  const m = Number(ymd.slice(5, 7));
  return [
    new RegExp(`(^|\\D)0?${d}\\s*[/.\\-]\\s*0?${m}(\\D|$)`),
    new RegExp(`ngày\\s*0?${d}\\s*(tháng|th\\.?)\\s*0?${m}(\\D|$)`),
  ];
}

/**
 * A06 gate: a date/time must not be scheduled from a doubtful OCR reading.
 * Doubt = the action cites an image whose OCR has an uncertain fragment with
 * digits, or a proposed date matches an uncertain fragment/alternative of
 * any image of the memo. Uncertainty comes from the stored OCR run, never
 * from the information model's own claim.
 */
function ocrTimeDoubt(rev: RevisionInfo, a: ActionShape): { fieldPath: string; question: string } | null {
  if (!rev.ocr || rev.ocr.length === 0) return null;
  const fields = TIME_FIELDS.filter((f) => typeof a.fields[f] === "string" && (a.fields[f] as string).length > 0);
  if (fields.length === 0) return null;
  const cited = new Set(a.evidence.map((e) => e.source_id));
  const patterns = fields.flatMap((f) => dayMonthPatterns(String(a.fields[f]), rev.timezone));
  for (const o of rev.ocr) {
    for (const u of o.uncertain) {
      const hay = [u.fragment, ...u.alternatives].map(normalizeText).join(" | ");
      if ((cited.has(o.runId) && /\d/.test(hay)) || patterns.some((p) => p.test(hay))) {
        const alts = u.alternatives.length > 0 ? ` (có thể là ${u.alternatives.join(" hoặc ")})` : "";
        return {
          fieldPath: fields.join(","),
          question: `Ảnh #${o.imagePosition + 1} ghi «${u.fragment}» chưa rõ${alts}. Bạn xác nhận thời gian đúng?`,
        };
      }
    }
  }
  return null;
}

/**
 * Turn validated fields into an executable plan. `currentVersion` is the
 * version the change may be applied on (the model's expected_version on the
 * automatic path, the live version after an explicit user answer).
 */
function planFor(rev: RevisionInfo, a: ActionShape, operation: "create" | "update"): { plan: Plan } | { problem: string; dateProblem: boolean } {
  const isDateIssue = (err: z.ZodError) =>
    err.issues.some((i) => ["starts_at", "local_date", "due_at", "due_date", "ends_at"].includes(String(i.path[0])));
  if (operation === "create") {
    if (a.entity_type === "task") {
      const f = aiTaskCreateFields.safeParse(a.fields);
      if (!f.success) return { problem: zodProblems(f.error), dateProblem: isDateIssue(f.error) };
      const { status: _s, category_id: _c, ...rest } = f.data;
      const input = taskCreateSchema.safeParse({ ...rest, source: sourceOf(rev, a), default_reminder: true });
      if (!input.success) return { problem: zodProblems(input.error), dateProblem: isDateIssue(input.error) };
      return { plan: { kind: "create_task", input: input.data } };
    }
    if (a.entity_type === "appointment") {
      const f = aiAppointmentCreateFields.safeParse(a.fields);
      if (!f.success) return { problem: zodProblems(f.error), dateProblem: isDateIssue(f.error) };
      const { category_id: _c, ...rest } = f.data;
      const input = appointmentCreateSchema.safeParse({
        ...rest,
        all_day: rest.all_day ?? false,
        timezone: rev.timezone,
        source: sourceOf(rev, a),
        default_reminder: true,
      });
      if (!input.success) return { problem: zodProblems(input.error), dateProblem: isDateIssue(input.error) };
      return { plan: { kind: "create_appointment", input: input.data } };
    }
    const f = aiNoteCreateFields.safeParse(a.fields);
    if (!f.success) return { problem: zodProblems(f.error), dateProblem: false };
    const input = noteCreateSchema.safeParse({ title: f.data.title, body: f.data.body ?? "", source: sourceOf(rev, a) });
    if (!input.success) return { problem: zodProblems(input.error), dateProblem: false };
    return { plan: { kind: "create_note", input: input.data } };
  }
  const id = a.target_id as string;
  if (a.entity_type === "task") {
    const f = aiTaskUpdateFields.safeParse(a.fields);
    if (!f.success) return { problem: zodProblems(f.error), dateProblem: isDateIssue(f.error) };
    return { plan: { kind: "update_task", id, fields: f.data } };
  }
  const f = aiAppointmentUpdateFields.safeParse(a.fields);
  if (!f.success) return { problem: zodProblems(f.error), dateProblem: isDateIssue(f.error) };
  return { plan: { kind: "update_appointment", id, fields: f.data } };
}

const SUPPORTED_TYPES = new Set(["task", "appointment", "note"]);

function decide(
  ctx: Ctx,
  rev: RevisionInfo,
  a: ProposalActionInput,
  candidates: Candidate[],
  statusByActionId: Map<string, ProposalActionStatus>,
): Decision {
  for (const e of a.evidence) {
    // A quote must be found verbatim in the source it names: the memo text or
    // the OCR run of one of its images (the run the model was given).
    const text = e.source_id === rev.id ? rev.text : rev.ocr?.find((o) => o.runId === e.source_id)?.text;
    if (text === undefined || !normalizeText(text).includes(normalizeText(e.quote))) {
      return { kind: "reject", reason: "evidence_mismatch" };
    }
  }
  for (const dep of a.depends_on) {
    if (statusByActionId.get(dep) !== "applied") return { kind: "wait", reason: `dependency_not_applied:${dep}` };
  }
  if (!SUPPORTED_TYPES.has(a.entity_type)) return { kind: "reject", reason: "entity_type_not_supported_yet" };

  // Asking for the exact value also covers request_confirmation: the user's
  // typed answer is the explicit decision.
  const doubt = ocrTimeDoubt(rev, a);
  if (doubt) {
    return { kind: "clarify", clarKind: "missing_fields", fieldPath: doubt.fieldPath, question: doubt.question, options: [], reason: "ocr_uncertain" };
  }

  const questions = a.ambiguity.map((x) => x.question).filter((q) => q.trim().length > 0);
  const paths = a.ambiguity.map((x) => x.field_path).filter((p) => p.length > 0);

  if (a.operation === "request_confirmation") {
    const operation = a.target_id ? "update" : "create";
    if (operation === "update" && (a.entity_type === "note" || !candidates.some((c) => c.id === a.target_id))) {
      return { kind: "reject", reason: "unknown_target" };
    }
    const planned = planFor(rev, a, operation);
    if ("problem" in planned) return { kind: "reject", reason: `invalid_fields: ${planned.problem}` };
    return {
      kind: "clarify",
      clarKind: "confirm",
      fieldPath: null,
      question: questions[0] ?? "Thay đổi này cần bạn xác nhận trước khi áp dụng.",
      options: [],
      reason: "needs_confirmation",
    };
  }

  if (a.operation === "create") {
    if (a.ambiguity.length > 0) {
      // Missing month/year, conflicting time, uncertain OCR: hold as draft,
      // never create an official item from a guess (A03/A05).
      return {
        kind: "clarify",
        clarKind: "missing_fields",
        fieldPath: paths.join(",") || null,
        question: questions.join(" ") || "Cần thêm thông tin để tạo mục này.",
        options: [],
        reason: "ambiguous",
      };
    }
    const planned = planFor(rev, a, "create");
    if ("problem" in planned) {
      if (planned.dateProblem) {
        return {
          kind: "clarify",
          clarKind: "missing_fields",
          fieldPath: a.entity_type === "appointment" ? "starts_at" : "due_date",
          question: "Thời gian chưa rõ hoặc không hợp lệ. Bạn muốn đặt lúc nào?",
          options: [],
          reason: `invalid_time: ${planned.problem}`,
        };
      }
      return { kind: "reject", reason: `invalid_fields: ${planned.problem}` };
    }
    return { kind: "apply", plan: planned.plan };
  }

  // update
  if (a.entity_type === "note") return { kind: "reject", reason: "note_update_not_supported" };
  const sameType = candidates.filter((c) => c.entity_type === a.entity_type);
  if (a.ambiguity.length > 0 || !a.target_id) {
    // Two matching targets (A12): ask, never pick one.
    return {
      kind: "clarify",
      clarKind: "choose_target",
      fieldPath: "target_id",
      question: questions.join(" ") || "Có nhiều mục phù hợp. Bạn muốn thay đổi mục nào?",
      options: sameType.slice(0, 10).map((c) => ({ value: c.id, label: candidateLabel(c) })),
      reason: "ambiguous_target",
    };
  }
  if (!sameType.some((c) => c.id === a.target_id)) return { kind: "reject", reason: "unknown_target" };
  const planned = planFor(rev, a, "update");
  if ("problem" in planned) return { kind: "reject", reason: `invalid_fields: ${planned.problem}` };
  const row = loadTarget(ctx, a.entity_type, a.target_id);
  if (!row || row.archived_at) return { kind: "reject", reason: "target_missing" };
  if ("status" in (planned.plan as { fields: Record<string, unknown> }).fields) {
    // Cancel/complete/archive always waits for a specific confirmation.
    return {
      kind: "clarify",
      clarKind: "confirm",
      fieldPath: "status",
      question: `Xác nhận đổi trạng thái «${String(row.title)}»?`,
      options: [],
      reason: "status_change_needs_confirmation",
    };
  }
  if (a.expected_version === null || Number(row.version) !== a.expected_version) {
    // The user edited it after the AI read it (A10): revalidate, never overwrite.
    return {
      kind: "clarify",
      clarKind: "revalidate",
      fieldPath: null,
      question: `«${String(row.title)}» đã được sửa sau khi AI đọc. Vẫn áp dụng thay đổi?`,
      options: [],
      reason: "target_changed",
    };
  }
  return { kind: "apply", plan: planned.plan };
}

/* ------------------------------------------------------------------ */
/* Execution                                                           */
/* ------------------------------------------------------------------ */

type Applied = { entityType: string; entityId: string };

function execute(ctx: Ctx, rev: RevisionInfo, a: ActionShape, plan: Plan, version: number | null): Applied {
  switch (plan.kind) {
    case "create_task":
      return { entityType: "task", entityId: entities.createTask(ctx, plan.input).id };
    case "create_appointment":
      return { entityType: "appointment", entityId: entities.createAppointment(ctx, plan.input).id };
    case "create_note":
      return { entityType: "note", entityId: entities.createNote(ctx, plan.input).id };
    case "update_task": {
      const v = version as number;
      const { status, ...fields } = plan.fields as { status?: "done" | "archived" };
      let current = v;
      if (Object.keys(fields).length > 0) {
        current = entities.patchTask(ctx, plan.id, taskPatchSchema.parse({ ...fields, expected_version: v })).version;
      }
      if (status === "done") entities.setTaskDone(ctx, plan.id, current, true);
      if (status === "archived") entities.archiveEntity(ctx, "task", plan.id, current);
      entities.linkSource(ctx, "task", plan.id, sourceOf(rev, a));
      return { entityType: "task", entityId: plan.id };
    }
    case "update_appointment": {
      entities.patchAppointment(ctx, plan.id, appointmentPatchSchema.parse({ ...plan.fields, expected_version: version }));
      entities.linkSource(ctx, "appointment", plan.id, sourceOf(rev, a));
      return { entityType: "appointment", entityId: plan.id };
    }
  }
}

/** Run `fn` inside a savepoint so one failing action cannot poison the others. */
function savepoint<T>(ctx: Ctx, fn: () => T): { ok: true; value: T } | { ok: false; error: unknown } {
  ctx.db.exec("SAVEPOINT action_apply");
  try {
    const value = fn();
    ctx.db.exec("RELEASE action_apply");
    return { ok: true, value };
  } catch (error) {
    ctx.db.exec("ROLLBACK TO action_apply");
    ctx.db.exec("RELEASE action_apply");
    return { ok: false, error };
  }
}

function supersedeOlderOpenActions(ctx: Ctx, revisionId: string, keepProposalId: string): void {
  const now = nowIso(ctx);
  const touched = ctx.db
    .prepare(
      `SELECT DISTINCT proposal_id FROM proposal_actions WHERE memo_revision_id = ? AND proposal_id <> ?
         AND status IN ('needs_clarification', 'waiting_dependency')`,
    )
    .all(revisionId, keepProposalId) as Row[];
  ctx.db
    .prepare(
      `UPDATE clarifications SET state = 'dismissed', version = version + 1, updated_at = ?
       WHERE state = 'open' AND proposal_action_id IN (
         SELECT id FROM proposal_actions WHERE memo_revision_id = ? AND proposal_id <> ?)`,
    )
    .run(now, revisionId, keepProposalId);
  ctx.db
    .prepare(
      `UPDATE proposal_actions SET status = 'dismissed', reason = 'superseded', version = version + 1, updated_at = ?
       WHERE memo_revision_id = ? AND proposal_id <> ? AND status IN ('needs_clarification', 'waiting_dependency')`,
    )
    .run(now, revisionId, keepProposalId);
  for (const r of touched) refreshProposalState(ctx, String(r.proposal_id));
}

export class StaleJobError extends Error {
  constructor() {
    super("job lease was reclaimed; commit refused (fencing token)");
  }
}

function insertAction(
  ctx: Ctx,
  proposalId: string,
  rev: RevisionInfo,
  a: ProposalActionInput,
  stableKey: string,
  status: ProposalActionStatus,
  reason: string | null,
  result: Applied | null,
  groupId: string | null,
): string {
  const id = newId();
  const now = nowIso(ctx);
  ctx.db
    .prepare(
      `INSERT INTO proposal_actions (id, owner_id, proposal_id, memo_revision_id, model_action_id, stable_key, operation,
         entity_type, target_id, expected_version, fields_json, evidence_json, depends_on_json, status, reason,
         result_entity_type, result_entity_id, action_group_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      OWNER_ID,
      proposalId,
      rev.id,
      a.action_id,
      stableKey,
      a.operation,
      a.entity_type,
      a.target_id,
      a.expected_version,
      JSON.stringify(a.fields),
      JSON.stringify(a.evidence),
      JSON.stringify(a.depends_on),
      status,
      reason,
      result?.entityType ?? null,
      result?.entityId ?? null,
      groupId,
      now,
      now,
    );
  return id;
}

function insertClarification(ctx: Ctx, actionId: string, d: Extract<Decision, { kind: "clarify" }>): void {
  const now = nowIso(ctx);
  ctx.db
    .prepare(
      `INSERT INTO clarifications (id, owner_id, proposal_action_id, kind, field_path, question, options_json,
         created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(newId(), OWNER_ID, actionId, d.clarKind, d.fieldPath, d.question, JSON.stringify(d.options), now, now);
}

function createActionGroup(ctx: Ctx, rev: RevisionInfo, promptVersion: string | null, payload: unknown): string {
  const id = newId();
  const now = nowIso(ctx);
  ctx.db
    .prepare(
      `INSERT INTO action_groups (id, owner_id, source_revision_id, prompt_version, payload_json, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'proposed', ?, ?)`,
    )
    .run(id, OWNER_ID, rev.id, promptVersion, JSON.stringify(payload), now, now);
  return id;
}

function setGroupState(ctx: Ctx, id: string, state: "applied" | "proposed" | "undone"): void {
  ctx.db
    .prepare("UPDATE action_groups SET state = ?, version = version + 1, updated_at = ? WHERE id = ?")
    .run(state, nowIso(ctx), id);
}

function similarAppliedExists(ctx: Ctx, rev: RevisionInfo, a: ProposalActionInput): boolean {
  if (a.operation !== "create" || typeof a.fields.title !== "string") return false;
  const rows = ctx.db
    .prepare(
      `SELECT fields_json FROM proposal_actions
       WHERE memo_revision_id = ? AND status = 'applied' AND operation = 'create' AND entity_type = ?`,
    )
    .all(rev.id, a.entity_type) as Row[];
  const title = normalizeText(a.fields.title);
  return rows.some((r) => {
    const f = JSON.parse(String(r.fields_json)) as { title?: unknown };
    return typeof f.title === "string" && normalizeText(f.title) === title;
  });
}

export type ApplyArgs = {
  jobId: string;
  fencingToken: number;
  revision: RevisionInfo;
  proposal: ProposalEnvelope;
  candidates: Candidate[];
  promptVersion: string;
  modelId: string | null;
  connectionId: string | null;
};

export type ApplySummary = { proposalId: string; state: string; applied: number; clarifications: number };

/**
 * Apply a validated proposal in ONE transaction: entities, source links,
 * reminders, audit, clarifications and the job's success, guarded by the
 * fencing token so a late result from a reclaimed lease commits nothing (A32).
 */
export function applyProposal(ctx: Ctx, args: ApplyArgs): ApplySummary {
  return transaction(ctx.db, () => {
    const fence = ctx.db
      .prepare("SELECT fencing_token, state FROM jobs WHERE id = ?")
      .get(args.jobId) as Row | undefined;
    if (!fence || Number(fence.fencing_token) !== args.fencingToken || fence.state !== "running") {
      throw new StaleJobError();
    }
    const rev = args.revision;
    const groupId = createActionGroup(ctx, rev, args.promptVersion, args.proposal);
    const proposalId = newId();
    const now = nowIso(ctx);
    ctx.db
      .prepare(
        `INSERT INTO proposals (id, owner_id, job_id, memo_revision_id, schema_version, prompt_version, model_id,
           connection_id, payload_json, state, action_group_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'nothing_to_apply', ?, ?, ?)`,
      )
      .run(
        proposalId,
        OWNER_ID,
        args.jobId,
        rev.id,
        args.proposal.schema_version,
        args.promptVersion,
        args.modelId,
        args.connectionId,
        JSON.stringify(args.proposal),
        groupId,
        now,
        now,
      );
    const aiCtx: Ctx = { ...ctx, actor: "ai", actionGroupId: groupId, auditSource: "ai" };
    const status = new Map<string, ProposalActionStatus>();
    let applied = 0;
    let clarifications = 0;

    // Independent actions first; dependants after the actions they need.
    const pending = [...args.proposal.actions];
    for (let pass = 0; pass < 3 && pending.length > 0; pass++) {
      for (let i = 0; i < pending.length; ) {
        const a = pending[i] as ProposalActionInput;
        const depsKnown = a.depends_on.every((d) => status.has(d));
        if (!depsKnown && pass < 2) {
          i++;
          continue;
        }
        pending.splice(i, 1);
        const key = stableActionKey(a);
        const prior = ctx.db
          .prepare(
            `SELECT result_entity_type, result_entity_id FROM proposal_actions
             WHERE memo_revision_id = ? AND stable_key = ? AND status = 'applied'`,
          )
          .get(rev.id, key) as Row | undefined;
        if (prior) {
          // Same source + same action already committed (retry/reprocess, A08).
          insertAction(ctx, proposalId, rev, a, key, "duplicate", "already_applied", {
            entityType: String(prior.result_entity_type),
            entityId: String(prior.result_entity_id),
          }, null);
          status.set(a.action_id, "applied");
          continue;
        }
        let decision = decide(ctx, rev, a, args.candidates, status);
        if (decision.kind === "apply" && similarAppliedExists(ctx, rev, a)) {
          decision = {
            kind: "clarify",
            clarKind: "confirm",
            fieldPath: null,
            question: `Memo này đã tạo «${String(a.fields.title)}». Tạo thêm một mục nữa?`,
            options: [],
            reason: "possible_duplicate",
          };
        }
        if (decision.kind === "apply") {
          const plan = decision.plan;
          const res = savepoint(ctx, () => execute(aiCtx, rev, a, plan, a.expected_version));
          if (res.ok) {
            insertAction(ctx, proposalId, rev, a, key, "applied", null, res.value, groupId);
            status.set(a.action_id, "applied");
            applied++;
          } else {
            const reason = res.error instanceof DomainError ? `apply_failed: ${res.error.message}` : "apply_failed";
            insertAction(ctx, proposalId, rev, a, key, "rejected", reason, null, null);
            status.set(a.action_id, "rejected");
          }
        } else if (decision.kind === "clarify") {
          const actionId = insertAction(ctx, proposalId, rev, a, key, "needs_clarification", decision.reason, null, null);
          insertClarification(ctx, actionId, decision);
          status.set(a.action_id, "needs_clarification");
          clarifications++;
        } else if (decision.kind === "wait") {
          insertAction(ctx, proposalId, rev, a, key, "waiting_dependency", decision.reason, null, null);
          status.set(a.action_id, "waiting_dependency");
        } else {
          insertAction(ctx, proposalId, rev, a, key, "rejected", decision.reason, null, null);
          status.set(a.action_id, "rejected");
        }
      }
    }

    // Open questions of earlier proposals for this revision are stale now
    // (reprocess, OCR correction): this proposal re-asks whatever is still
    // unclear, so the old ones are closed instead of left to be answered twice.
    supersedeOlderOpenActions(ctx, rev.id, proposalId);

    const state =
      applied > 0 && clarifications > 0
        ? "partial"
        : applied > 0
          ? "applied"
          : clarifications > 0
            ? "needs_clarification"
            : "nothing_to_apply";
    ctx.db.prepare("UPDATE proposals SET state = ?, updated_at = ? WHERE id = ?").run(state, nowIso(ctx), proposalId);
    if (applied > 0) setGroupState(ctx, groupId, "applied");

    const done = ctx.db
      .prepare(
        `UPDATE jobs SET state = 'succeeded', lease_owner = NULL, lease_expires_at = NULL, error_code = NULL,
           error_message = NULL, version = version + 1, updated_at = ?
         WHERE id = ? AND fencing_token = ? AND state = 'running'`,
      )
      .run(nowIso(ctx), args.jobId, args.fencingToken);
    if (Number(done.changes) === 0) throw new StaleJobError();
    return { proposalId, state, applied, clarifications };
  });
}

/* ------------------------------------------------------------------ */
/* Read models                                                         */
/* ------------------------------------------------------------------ */

export function toProposalAction(r: Row): ProposalAction {
  const evidence = JSON.parse(String(r.evidence_json)) as Array<{ quote?: unknown; source_id?: unknown }>;
  // Evidence from an image names the OCR run it quoted; memo text names the revision.
  const ocrRunOf = (e: { source_id?: unknown }) =>
    typeof e.source_id === "string" && e.source_id !== String(r.memo_revision_id) ? e.source_id : null;
  return {
    id: String(r.id),
    proposal_id: String(r.proposal_id),
    operation: String(r.operation),
    entity_type: String(r.entity_type),
    target_id: (r.target_id as string | null) ?? null,
    status: r.status as ProposalActionStatus,
    reason: (r.reason as string | null) ?? null,
    fields: JSON.parse(String(r.fields_json)) as Record<string, unknown>,
    evidence: evidence.map((e) => ({ quote: String(e.quote ?? ""), ocr_run_id: ocrRunOf(e) })),
    result_entity_type: (r.result_entity_type as string | null) ?? null,
    result_entity_id: (r.result_entity_id as string | null) ?? null,
    action_group_id: (r.action_group_id as string | null) ?? null,
    created_at: String(r.created_at),
  };
}

export function toClarification(r: Row): Clarification {
  return {
    id: String(r.id),
    proposal_action_id: String(r.proposal_action_id),
    kind: r.kind as ClarificationKind,
    field_path: (r.field_path as string | null) ?? null,
    question: String(r.question),
    options: JSON.parse(String(r.options_json)) as Clarification["options"],
    state: r.state as Clarification["state"],
    version: Number(r.version),
    created_at: String(r.created_at),
  };
}

export function memoAiState(ctx: Ctx, memoId: string): { actions: ProposalAction[]; clarifications: Clarification[] } {
  const actions = ctx.db
    .prepare(
      `SELECT pa.* FROM proposal_actions pa JOIN memo_revisions r ON r.id = pa.memo_revision_id
       WHERE r.memo_id = ? AND pa.owner_id = ? ORDER BY pa.created_at DESC, pa.rowid`,
    )
    .all(memoId, OWNER_ID) as Row[];
  const clarifications = ctx.db
    .prepare(
      `SELECT c.* FROM clarifications c JOIN proposal_actions pa ON pa.id = c.proposal_action_id
       JOIN memo_revisions r ON r.id = pa.memo_revision_id
       WHERE r.memo_id = ? AND c.owner_id = ? ORDER BY c.created_at DESC, c.rowid`,
    )
    .all(memoId, OWNER_ID) as Row[];
  return { actions: actions.map(toProposalAction), clarifications: clarifications.map(toClarification) };
}

export function listOpenClarifications(ctx: Ctx, limit: number): Clarification[] {
  const rows = ctx.db
    .prepare(`SELECT * FROM clarifications WHERE owner_id = ? AND state = 'open' ORDER BY created_at DESC LIMIT ?`)
    .all(OWNER_ID, limit) as Row[];
  return rows.map(toClarification);
}

/* ------------------------------------------------------------------ */
/* Clarification answers (POST /clarifications/:id/answer)             */
/* ------------------------------------------------------------------ */

function refreshProposalState(ctx: Ctx, proposalId: string): void {
  const rows = ctx.db.prepare("SELECT status FROM proposal_actions WHERE proposal_id = ?").all(proposalId) as Row[];
  const applied = rows.filter((r) => r.status === "applied").length;
  const open = rows.filter((r) => r.status === "needs_clarification").length;
  const state = applied > 0 && open > 0 ? "partial" : applied > 0 ? "applied" : open > 0 ? "needs_clarification" : "nothing_to_apply";
  ctx.db.prepare("UPDATE proposals SET state = ?, version = version + 1, updated_at = ? WHERE id = ?").run(state, nowIso(ctx), proposalId);
}

/** Caller runs this inside a transaction. */
export function answerClarification(ctx: Ctx, id: string, input: ClarificationAnswer): ClarificationResult {
  const clar = ctx.db.prepare("SELECT * FROM clarifications WHERE id = ? AND owner_id = ?").get(id, OWNER_ID) as Row | undefined;
  if (!clar) throw notFound("Câu hỏi làm rõ");
  if (Number(clar.version) !== input.expected_version) throw versionConflict("Câu hỏi làm rõ");
  if (clar.state !== "open") throw new DomainError("CONFLICT", "Câu hỏi này đã được trả lời.");
  const actionRow = ctx.db.prepare("SELECT * FROM proposal_actions WHERE id = ?").get(String(clar.proposal_action_id)) as Row;
  const rev = ctx.db
    .prepare(
      `SELECT r.id, r.memo_id, r.raw_text, r.timezone FROM memo_revisions r WHERE r.id = ?`,
    )
    .get(String(actionRow.memo_revision_id)) as Row;
  const revision: RevisionInfo = {
    id: String(rev.id),
    memoId: String(rev.memo_id),
    text: String(rev.raw_text),
    timezone: String(rev.timezone),
  };
  const kind = clar.kind as ClarificationKind;
  const answer = input.answer;
  const now = nowIso(ctx);

  const finish = (clarState: "answered" | "dismissed", actionStatus: ProposalActionStatus, result: Applied | null, groupId: string | null, reason: string | null) => {
    ctx.db
      .prepare("UPDATE clarifications SET state = ?, answer_json = ?, version = version + 1, updated_at = ? WHERE id = ?")
      .run(clarState, JSON.stringify(answer), now, id);
    try {
      ctx.db
        .prepare(
          `UPDATE proposal_actions SET status = ?, reason = ?, result_entity_type = ?, result_entity_id = ?,
             action_group_id = ?, version = version + 1, updated_at = ? WHERE id = ?`,
        )
        .run(actionStatus, reason, result?.entityType ?? null, result?.entityId ?? null, groupId, now, String(actionRow.id));
    } catch {
      throw new DomainError("CONFLICT", "Hành động tương tự đã được áp dụng từ memo này.");
    }
    refreshProposalState(ctx, String(actionRow.proposal_id));
    // Other open clarifications of the same action are settled together.
    ctx.db
      .prepare(
        `UPDATE clarifications SET state = 'dismissed', version = version + 1, updated_at = ?
         WHERE proposal_action_id = ? AND state = 'open' AND id <> ?`,
      )
      .run(now, String(actionRow.id), id);
    const c = ctx.db.prepare("SELECT * FROM clarifications WHERE id = ?").get(id) as Row;
    const a = ctx.db.prepare("SELECT * FROM proposal_actions WHERE id = ?").get(String(actionRow.id)) as Row;
    return { clarification: toClarification(c), action: toProposalAction(a) };
  };

  if ("dismiss" in answer) return finish("dismissed", "dismissed", null, null, "dismissed_by_user");

  const action: ActionShape = {
    operation: actionRow.operation as ActionShape["operation"],
    entity_type: actionRow.entity_type as ActionShape["entity_type"],
    target_id: (actionRow.target_id as string | null) ?? null,
    expected_version: (actionRow.expected_version as number | null) ?? null,
    fields: JSON.parse(String(actionRow.fields_json)) as Record<string, unknown>,
    evidence: JSON.parse(String(actionRow.evidence_json)) as ActionShape["evidence"],
  };

  if (kind === "missing_fields") {
    if (!("fields" in answer)) throw new DomainError("BAD_REQUEST", "Câu hỏi này cần answer.fields.");
    action.fields = { ...action.fields, ...answer.fields };
  } else if (kind === "choose_target") {
    if (!("choice" in answer)) throw new DomainError("BAD_REQUEST", "Câu hỏi này cần answer.choice.");
    const options = JSON.parse(String(clar.options_json)) as Array<{ value: string }>;
    if (!options.some((o) => o.value === answer.choice)) {
      throw new DomainError("BAD_REQUEST", "Lựa chọn không nằm trong danh sách.", { "answer.choice": "Không hợp lệ." });
    }
    action.target_id = answer.choice;
  } else if (!("confirm" in answer)) {
    throw new DomainError("BAD_REQUEST", "Câu hỏi này cần answer.confirm = true.");
  }

  const operation = action.target_id && action.operation !== "create" ? "update" : "create";
  const planned = planFor(revision, action, operation);
  if ("problem" in planned) {
    throw new DomainError("BAD_REQUEST", "Dữ liệu trả lời chưa hợp lệ.", { "answer.fields": planned.problem });
  }
  let version: number | null = null;
  if (operation === "update") {
    const row = loadTarget(ctx, action.entity_type, action.target_id as string);
    if (!row || row.archived_at) throw new DomainError("UNPROCESSABLE_ENTITY", "Mục cần sửa không còn tồn tại.");
    // The user answered with the item in front of them: apply on its live version.
    version = Number(row.version);
  }
  const groupId = createActionGroup(ctx, revision, null, { clarification_id: id, answer });
  const userCtx: Ctx = { ...ctx, actor: "user", actionGroupId: groupId, auditSource: "ai_clarification" };
  const result = execute(userCtx, revision, action, planned.plan, version);
  setGroupState(ctx, groupId, "applied");
  if (operation === "update" || "fields" in answer || "choice" in answer) {
    ctx.db
      .prepare("UPDATE proposal_actions SET target_id = ?, fields_json = ? WHERE id = ?")
      .run(action.target_id, JSON.stringify(action.fields), String(actionRow.id));
  }
  return finish("answered", "applied", result, groupId, "answered_by_user");
}

/* ------------------------------------------------------------------ */
/* Undo (POST /action-groups/:id/undo, A11/A17)                         */
/* ------------------------------------------------------------------ */

const REVERTIBLE: Record<string, string[]> = {
  task: ["title", "description", "due_date", "due_at", "planned_at", "status"],
  appointment: ["title", "starts_at", "ends_at", "status"],
  note: ["title", "body"],
};

/**
 * Revert every entity change of an action group, newest first, but only when
 * each entity is still exactly as the group left it. Any later manual edit
 * yields a 409 with the conflicting entities; nothing is reverted partially.
 */
export function undoActionGroup(ctx: Ctx, groupId: string): UndoResult {
  const group = ctx.db.prepare("SELECT * FROM action_groups WHERE id = ? AND owner_id = ?").get(groupId, OWNER_ID) as Row | undefined;
  if (!group) throw notFound("Nhóm thay đổi");
  if (group.state === "undone") throw new DomainError("CONFLICT", "Nhóm thay đổi này đã được hoàn tác.");
  if (group.state !== "applied") throw new DomainError("UNPROCESSABLE_ENTITY", "Nhóm này không có thay đổi để hoàn tác.");
  const events = ctx.db
    .prepare(
      `SELECT * FROM audit_events WHERE action_group_id = ? AND entity_type IN ('task', 'appointment', 'note')
       ORDER BY created_at DESC, rowid DESC`,
    )
    .all(groupId) as Row[];

  // Final state per entity left by this group = the newest event's "after".
  const latest = new Map<string, Row>();
  const earliest = new Map<string, Row>();
  for (const e of events) {
    const key = `${String(e.entity_type)}/${String(e.entity_id)}`;
    if (!latest.has(key)) latest.set(key, e);
    earliest.set(key, e);
  }
  const conflicts: Record<string, string> = {};
  for (const [key, e] of latest) {
    const after = JSON.parse(String(e.after_json)) as Record<string, unknown>;
    const row = loadTarget(ctx, String(e.entity_type), String(e.entity_id));
    if (!row) {
      conflicts[key] = "Đối tượng không còn tồn tại.";
      continue;
    }
    if (Number(row.version) !== Number(after.version)) {
      const fields = (REVERTIBLE[String(e.entity_type)] ?? []).filter(
        (f) => JSON.stringify(row[f] ?? null) !== JSON.stringify(after[f] ?? null),
      );
      conflicts[key] = `Đã được sửa sau thay đổi của AI${fields.length ? `: ${fields.join(", ")}` : ""}.`;
    }
  }
  if (Object.keys(conflicts).length > 0) {
    throw new DomainError("CONFLICT", "Không thể hoàn tác vì dữ liệu đã được sửa sau đó.", conflicts);
  }

  const undoCtx: Ctx = { ...ctx, actor: "user", auditSource: "undo", actionGroupId: undefined };
  const reverted: UndoResult["reverted"] = [];
  for (const [key, first] of earliest) {
    const type = String(first.entity_type);
    const entityId = String(first.entity_id);
    const row = loadTarget(ctx, type, entityId) as Row;
    const version = Number(row.version);
    if (String(first.action).endsWith(".create")) {
      entities.archiveEntity(undoCtx, type, entityId, version);
    } else {
      const before = JSON.parse(String(first.before_json)) as Record<string, unknown>;
      if (type === "task") {
        const patch: Record<string, unknown> = { expected_version: version };
        for (const f of ["title", "description", "due_date", "due_at", "planned_at", "status"]) patch[f] = before[f] ?? null;
        if (patch.due_date && patch.due_at) patch.due_at = null;
        if (patch.title === null) delete patch.title;
        if (patch.status === null) delete patch.status;
        entities.patchTask(undoCtx, entityId, taskPatchSchema.parse(patch));
      } else if (type === "appointment") {
        const patch: Record<string, unknown> = { expected_version: version, title: before.title, ends_at: before.ends_at ?? null };
        if (before.starts_at) patch.starts_at = before.starts_at;
        if (before.status) patch.status = before.status;
        entities.patchAppointment(undoCtx, entityId, appointmentPatchSchema.parse(patch));
      } else {
        entities.patchNote(undoCtx, entityId, { expected_version: version, title: String(before.title), body: String(before.body ?? "") });
      }
    }
    reverted.push({ entity_type: type, entity_id: entityId });
    void key;
  }
  setGroupState(ctx, groupId, "undone");
  ctx.db
    .prepare("UPDATE proposal_actions SET reason = 'undone', version = version + 1, updated_at = ? WHERE action_group_id = ?")
    .run(nowIso(ctx), groupId);
  return { action_group_id: groupId, state: "undone", reverted };
}
