import { randomUUID } from "node:crypto";
import type { Job, JobState } from "@personalass/contracts";
import { isRetryable, needsConfiguration, ProviderError } from "../ai/errors.js";
import { buildOcrMessages, buildOcrRepairMessages, loadOcrPrompt, ocrJsonSchema, parseOcrOutput, type OcrImageResult } from "../ai/ocr.js";
import { OpenAiCompatibleClient, type ChatMessage } from "../ai/openai-compatible.js";
import {
  buildInformationMessages,
  buildRepairMessages,
  formatCapturedLocal,
  loadInformationPrompt,
  type Candidate,
  type OcrSource,
  type PromptBundle,
} from "../ai/prompt.js";
import { proposalJsonSchema, type ProposalEnvelope } from "../ai/proposal-schema.js";
import type { DataPaths } from "../config.js";
import { transaction, type Db } from "../db/open.js";
import { getRole, resolveConnection, type AiDeps } from "../domain/ai-config.js";
import { DomainError, OWNER_ID, loadSettings, newId, notFound, nowIso, type Clock, type Ctx, type Row } from "../domain/core.js";
import { applyProposal, parseModelOutput, StaleJobError, type OcrEvidenceSource, type RevisionInfo } from "../domain/proposals.js";
import type { Logger } from "../logger.js";
import { attachmentsOfRevision, effectiveOcrRun, readDerivedImage, type AttachmentRow } from "../storage/attachments.js";

/**
 * Durable job worker (docs/02 §3-4): claim with a conditional update and a
 * fencing token, heartbeat while the provider call runs (never inside a
 * transaction), commit through applyProposal which re-checks the token.
 */

export const LEASE_MS = 90_000;
export const HEARTBEAT_MS = 15_000;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 30 * 60_000;
const CANDIDATE_LIMIT = 30;

export type WorkerDeps = {
  db: Db;
  clock: Clock;
  ai: AiDeps;
  logger: Logger;
  workerId?: string;
  prompt?: PromptBundle;
  ocrPrompt?: PromptBundle;
  /** Where attachment files live; required to process memos with images. */
  paths?: Pick<DataPaths, "attachmentsDerived">;
  /** Injectable for tests: jitter source in [0, 1). */
  random?: () => number;
  heartbeatMs?: number;
};

export function toJob(r: Row): Job {
  return {
    id: String(r.id),
    kind: "process_memo",
    memo_revision_id: String(r.memo_revision_id),
    state: r.state as JobState,
    attempt: Number(r.attempt),
    max_attempts: Number(r.max_attempts),
    run_after: String(r.run_after),
    error_code: (r.error_code as string | null) ?? null,
    error_message: (r.error_message as string | null) ?? null,
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
  };
}

/* ---- queue operations (callers own the transaction where noted) ---- */

/** Enqueue processing of a memo revision. Caller runs inside a transaction. */
export function enqueueMemoJob(ctx: Ctx, revisionId: string, previousJobId: string | null = null): string {
  const id = newId();
  const now = nowIso(ctx);
  ctx.db
    .prepare(
      `INSERT INTO jobs (id, owner_id, kind, memo_revision_id, previous_job_id, state, run_after, created_at, updated_at)
       VALUES (?, ?, 'process_memo', ?, ?, 'queued', ?, ?, ?)`,
    )
    .run(id, OWNER_ID, revisionId, previousJobId, now, now, now);
  return id;
}

export function getJob(ctx: Ctx, id: string): Job {
  const row = ctx.db.prepare("SELECT * FROM jobs WHERE id = ? AND owner_id = ?").get(id, OWNER_ID) as Row | undefined;
  if (!row) throw notFound("Job");
  return toJob(row);
}

export function latestJobForRevision(ctx: Ctx, revisionId: string): Job | null {
  const row = ctx.db
    .prepare("SELECT * FROM jobs WHERE memo_revision_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
    .get(revisionId) as Row | undefined;
  return row ? toJob(row) : null;
}

const ACTIVE_STATES = new Set(["queued", "running", "retry_wait"]);

/** POST /memos/:id/reprocess: new job linked to the previous run. Caller owns the transaction. */
export function reprocessMemo(ctx: Ctx, memoId: string): Job {
  const memo = ctx.db.prepare("SELECT current_revision_id FROM memos WHERE id = ? AND owner_id = ?").get(memoId, OWNER_ID) as
    | Row
    | undefined;
  if (!memo) throw notFound("Memo");
  const revisionId = String(memo.current_revision_id);
  const last = latestJobForRevision(ctx, revisionId);
  if (last && ACTIVE_STATES.has(last.state)) {
    throw new DomainError("CONFLICT", "Memo đang được xử lý; chờ job hiện tại kết thúc.");
  }
  // A job still waiting for configuration is replaced, not left to wake up
  // later and process the same revision a second time.
  const now = nowIso(ctx);
  ctx.db
    .prepare(
      `UPDATE jobs SET state = 'cancelled', error_code = 'superseded', error_message = ?, version = version + 1, updated_at = ?
       WHERE memo_revision_id = ? AND state = 'waiting_configuration'`,
    )
    .run("Đã thay bằng lần xử lý mới.", now, revisionId);
  return getJob(ctx, enqueueMemoJob(ctx, revisionId, last?.id ?? null));
}

export type Claimed = { id: string; fencingToken: number; attempt: number; revisionId: string };

/** Claim the next due job (or one whose lease expired) in one transaction. */
export function claimNextJob(ctx: Ctx, workerId: string): Claimed | null {
  return transaction(ctx.db, () => {
    const now = nowIso(ctx);
    for (;;) {
      const row = ctx.db
        .prepare(
          `SELECT * FROM jobs WHERE owner_id = ? AND (
             (state IN ('queued', 'retry_wait') AND run_after <= ?) OR
             (state = 'running' AND lease_expires_at < ?))
           ORDER BY run_after, created_at LIMIT 1`,
        )
        .get(OWNER_ID, now, now) as Row | undefined;
      if (!row) return null;
      if (row.state === "running" && Number(row.attempt) >= Number(row.max_attempts)) {
        // Crashed or hung on its last attempt: stop instead of looping forever.
        ctx.db
          .prepare(
            `UPDATE jobs SET state = 'failed', error_code = 'lease_expired', error_message = ?, lease_owner = NULL,
               fencing_token = fencing_token + 1, version = version + 1, updated_at = ? WHERE id = ?`,
          )
          .run("Hết lượt thử sau khi tiến trình xử lý bị gián đoạn.", now, String(row.id));
        continue;
      }
      const leaseUntil = new Date(ctx.clock().getTime() + LEASE_MS).toISOString();
      const res = ctx.db
        .prepare(
          `UPDATE jobs SET state = 'running', attempt = attempt + 1, fencing_token = fencing_token + 1,
             lease_owner = ?, lease_expires_at = ?, heartbeat_at = ?, version = version + 1, updated_at = ?
           WHERE id = ? AND version = ?`,
        )
        .run(workerId, leaseUntil, now, now, String(row.id), Number(row.version));
      if (Number(res.changes) === 0) return null;
      return {
        id: String(row.id),
        fencingToken: Number(row.fencing_token) + 1,
        attempt: Number(row.attempt) + 1,
        revisionId: String(row.memo_revision_id),
      };
    }
  });
}

function settleJob(
  ctx: Ctx,
  job: Claimed,
  state: Exclude<JobState, "running" | "queued" | "succeeded">,
  error: { code: string; message: string },
  runAfter?: string,
): boolean {
  const now = nowIso(ctx);
  const res = ctx.db
    .prepare(
      `UPDATE jobs SET state = ?, error_code = ?, error_message = ?, run_after = COALESCE(?, run_after),
         lease_owner = NULL, lease_expires_at = NULL, version = version + 1, updated_at = ?
       WHERE id = ? AND fencing_token = ? AND state = 'running'`,
    )
    .run(state, error.code, error.message, runAfter ?? null, now, job.id, job.fencingToken);
  return Number(res.changes) === 1;
}

function heartbeat(ctx: Ctx, job: Claimed): void {
  const now = nowIso(ctx);
  ctx.db
    .prepare(
      `UPDATE jobs SET heartbeat_at = ?, lease_expires_at = ? WHERE id = ? AND fencing_token = ? AND state = 'running'`,
    )
    .run(now, new Date(ctx.clock().getTime() + LEASE_MS).toISOString(), job.id, job.fencingToken);
}

/* ---- context building (read-only, outside any transaction) ---- */

function loadRevision(ctx: Ctx, revisionId: string): RevisionInfo & { capturedAt: string; privacy: string } {
  const row = ctx.db
    .prepare(
      `SELECT r.id, r.memo_id, r.raw_text, r.timezone, r.captured_at, m.privacy
       FROM memo_revisions r JOIN memos m ON m.id = r.memo_id WHERE r.id = ? AND m.owner_id = ?`,
    )
    .get(revisionId, OWNER_ID) as Row;
  return {
    id: String(row.id),
    memoId: String(row.memo_id),
    text: String(row.raw_text),
    timezone: String(row.timezone),
    capturedAt: String(row.captured_at),
    privacy: String(row.privacy),
  };
}

/** Bounded candidate set by query; never the whole database (docs/04 §3). */
export function loadCandidates(ctx: Ctx, capturedAt: string): Candidate[] {
  const since = new Date(Date.parse(capturedAt) - 24 * 3600_000).toISOString();
  const sinceDate = since.slice(0, 10);
  const appts = ctx.db
    .prepare(
      `SELECT id, version, title, starts_at, local_date FROM appointments
       WHERE owner_id = ? AND archived_at IS NULL AND status = 'scheduled'
         AND (starts_at >= ? OR local_date >= ?)
       ORDER BY COALESCE(starts_at, local_date) LIMIT ?`,
    )
    .all(OWNER_ID, since, sinceDate, CANDIDATE_LIMIT) as Row[];
  const tasks = ctx.db
    .prepare(
      `SELECT id, version, title, due_date, due_at FROM tasks
       WHERE owner_id = ? AND archived_at IS NULL AND status IN ('open', 'in_progress', 'waiting')
       ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(OWNER_ID, CANDIDATE_LIMIT) as Row[];
  return [
    ...appts.map((r) => ({
      entity_type: "appointment" as const,
      id: String(r.id),
      version: Number(r.version),
      title: String(r.title),
      starts_at: (r.starts_at as string | null) ?? null,
      local_date: (r.local_date as string | null) ?? null,
    })),
    ...tasks.map((r) => ({
      entity_type: "task" as const,
      id: String(r.id),
      version: Number(r.version),
      title: String(r.title),
      due_date: (r.due_date as string | null) ?? null,
      due_at: (r.due_at as string | null) ?? null,
    })),
  ];
}

type Target = { connectionId: string; modelId: string };

const ROLE_LABEL: Record<"information" | "ocr", string> = {
  information: "xử lý thông tin",
  ocr: "OCR (đọc ảnh)",
};

/**
 * Ordered provider targets for a role, after the privacy rules (docs/04 §6):
 * a local_only memo (text and images alike) never reaches a cloud
 * connection, and a local primary only falls back to cloud when allow_cloud
 * is set.
 */
function resolveTargets(ctx: Ctx, role: "information" | "ocr", privacy: string): { targets: Target[] } | { error: ProviderError } {
  const binding = getRole(ctx, role);
  if (!binding) {
    return {
      error: new ProviderError(
        "not_configured",
        role === "ocr"
          ? "Chưa chọn kết nối/model đọc được ảnh cho vai trò OCR."
          : "Chưa chọn kết nối/model cho vai trò xử lý thông tin.",
      ),
    };
  }
  const all: Target[] = [
    { connectionId: binding.connection_id, modelId: binding.model_id },
    ...binding.fallback.bindings.map((b) => ({ connectionId: b.connection_id, modelId: b.model_id })),
  ];
  const scopeOf = (id: string): { scope: "local" | "cloud"; enabled: boolean } | null => {
    const row = ctx.db
      .prepare("SELECT privacy_scope, enabled FROM ai_connections WHERE id = ? AND archived_at IS NULL")
      .get(id) as Row | undefined;
    return row ? { scope: row.privacy_scope as "local" | "cloud", enabled: Boolean(row.enabled) } : null;
  };
  const primary = scopeOf(binding.connection_id);
  const targets = all.filter((t, i) => {
    const s = scopeOf(t.connectionId);
    if (!s || !s.enabled) return false;
    if (privacy === "local_only" && s.scope !== "local") return false;
    if (i > 0 && primary?.scope === "local" && s.scope === "cloud" && !binding.fallback.allow_cloud) return false;
    return true;
  });
  if (targets.length === 0) {
    return {
      error: new ProviderError(
        "not_configured",
        privacy === "local_only"
          ? "Memo chỉ xử lý cục bộ nhưng không có kết nối local khả dụng; không gửi lên cloud."
          : `Không có kết nối AI nào đang bật cho vai trò ${ROLE_LABEL[role]}.`,
      ),
    };
  }
  return { targets };
}

function recordRun(
  ctx: Ctx,
  job: Claimed,
  t: Target,
  promptVersion: string,
  purpose: "extract" | "repair",
  status: "ok" | "provider_error" | "invalid_output",
  extra: { errorCode?: string; usage?: unknown; latencyMs?: number | null; role?: "information" | "ocr" },
): void {
  const now = nowIso(ctx);
  ctx.db
    .prepare(
      `INSERT INTO ai_runs (id, owner_id, job_id, role, connection_id, model_id, prompt_version, attempt, purpose,
         status, error_code, usage_json, latency_ms, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      newId(),
      OWNER_ID,
      job.id,
      extra.role ?? "information",
      t.connectionId,
      t.modelId,
      promptVersion,
      job.attempt,
      purpose,
      status,
      extra.errorCode ?? null,
      extra.usage ? JSON.stringify(extra.usage) : null,
      extra.latencyMs ?? null,
      now,
      now,
    );
}

function backoffMs(attempt: number, retryAfter: number | null, random: () => number): number {
  const exp = Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1), BACKOFF_MAX_MS);
  const jittered = exp + Math.floor(random() * 10_000);
  return Math.max(jittered, retryAfter ?? 0);
}

/** Settle a job after every allowed target failed: configuration, retry or failure. */
function settleProviderFailure(ctx: Ctx, deps: WorkerDeps, job: Claimed, err: ProviderError): void {
  if (needsConfiguration(err.code)) {
    settleJob(ctx, job, "waiting_configuration", { code: err.code, message: err.message });
  } else if (isRetryable(err.code) && job.attempt < maxAttempts(ctx, job.id)) {
    const runAfter = new Date(deps.clock().getTime() + backoffMs(job.attempt, err.retryAfterMs, deps.random ?? Math.random)).toISOString();
    settleJob(ctx, job, "retry_wait", { code: err.code, message: err.message }, runAfter);
  } else {
    settleJob(ctx, job, "failed", { code: err.code, message: err.message });
  }
}

const asProviderError = (err: unknown, fallback: string): ProviderError =>
  err instanceof ProviderError ? err : new ProviderError("unavailable", fallback);

/* ---- OCR stage (docs/04 §2) ---- */

/** OCR calls get at least this long; a connection may allow more (slow CPU Ollama). */
export const OCR_TIMEOUT_MS = 240_000;

type OcrOutcome =
  | { kind: "ok"; image: OcrImageResult; target: Target }
  | { kind: "invalid"; problems: string[] }
  | { kind: "provider_error"; error: ProviderError };

async function ocrOne(
  ctx: Ctx,
  deps: WorkerDeps,
  job: Claimed,
  targets: Target[],
  prompt: PromptBundle,
  attachment: AttachmentRow,
): Promise<OcrOutcome> {
  if (!deps.paths) throw new Error("worker has no data paths; cannot read attachments");
  const binding = getRole(ctx, "ocr");
  const messages = buildOcrMessages(prompt, {
    attachmentId: attachment.id,
    mime: attachment.derived_mime,
    bytes: readDerivedImage(deps.paths, attachment),
  });
  let lastError: ProviderError | null = null;
  for (const target of targets) {
    let client: OpenAiCompatibleClient;
    try {
      const conn = resolveConnection(ctx, deps.ai, target.connectionId);
      client = new OpenAiCompatibleClient({ ...conn, timeoutMs: Math.max(conn.timeoutMs, OCR_TIMEOUT_MS) }, deps.ai.transport);
    } catch (err) {
      lastError = err instanceof ProviderError ? err : new ProviderError("not_configured", "Kết nối AI không dùng được.");
      continue;
    }
    const call = async (msgs: ChatMessage[], purpose: "extract" | "repair") => {
      try {
        const out = await client.chat({
          model: target.modelId,
          messages: msgs,
          maxTokens: binding?.max_tokens ?? 4096,
          temperature: binding?.temperature ?? 0,
          jsonSchema: { name: "personalass_ocr", schema: ocrJsonSchema },
        });
        recordRun(ctx, job, target, prompt.version, purpose, "ok", { usage: out.usage, latencyMs: out.latencyMs, role: "ocr" });
        return out.content;
      } catch (err) {
        const pe = asProviderError(err, "Lỗi khi gọi provider OCR.");
        recordRun(ctx, job, target, prompt.version, purpose, "provider_error", { errorCode: pe.code, role: "ocr" });
        throw pe;
      }
    };
    let content: string;
    try {
      content = await call(messages, "extract");
    } catch (err) {
      lastError = err as ProviderError;
      // Another allowed target may still work; a hard error stops here.
      if (isRetryable(lastError.code) || needsConfiguration(lastError.code)) continue;
      break;
    }
    let parsed = parseOcrOutput(content, attachment.id);
    if (!parsed.ok) {
      recordRun(ctx, job, target, prompt.version, "extract", "invalid_output", { errorCode: "invalid_output", role: "ocr" });
      // One bounded repair attempt, then a clear failure (docs/04 §8).
      try {
        parsed = parseOcrOutput(await call(buildOcrRepairMessages(messages, content, parsed.problems), "repair"), attachment.id);
      } catch (err) {
        lastError = err as ProviderError;
        if (isRetryable(lastError.code) || needsConfiguration(lastError.code)) continue;
        break;
      }
      if (!parsed.ok) {
        recordRun(ctx, job, target, prompt.version, "repair", "invalid_output", { errorCode: "invalid_output", role: "ocr" });
        return { kind: "invalid", problems: parsed.problems };
      }
    }
    return { kind: "ok", image: parsed.image, target };
  }
  return { kind: "provider_error", error: lastError ?? new ProviderError("unavailable", "Không gọi được provider OCR nào.") };
}

/**
 * Store one OCR result. Guarded by the fencing token like every other
 * commit, and unique per (job, attachment), so a reclaimed or retried run
 * never stores a second result (A08/A32). Returns false when fenced.
 */
function commitOcrRun(ctx: Ctx, job: Claimed, attachment: AttachmentRow, target: Target, promptVersion: string, image: OcrImageResult): boolean {
  return transaction(ctx.db, () => {
    const fence = ctx.db.prepare("SELECT fencing_token, state FROM jobs WHERE id = ?").get(job.id) as Row | undefined;
    if (!fence || Number(fence.fencing_token) !== job.fencingToken || fence.state !== "running") return false;
    // The user corrected this image while the call was in flight: their run
    // stays effective; the late AI result is dropped, never stacked on top.
    if (effectiveOcrRun(ctx, attachment.id) !== null) return true;
    ctx.db
      .prepare(
        `INSERT OR IGNORE INTO ocr_runs (id, owner_id, attachment_id, job_id, author, connection_id, model_id, prompt_version,
           status, extracted_text, blocks_json, uncertainties_json, created_at)
         VALUES (?, ?, ?, ?, 'ai', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newId(),
        OWNER_ID,
        attachment.id,
        job.id,
        target.connectionId,
        target.modelId,
        promptVersion,
        image.status,
        image.transcription,
        JSON.stringify(image.blocks),
        JSON.stringify(image.uncertainties),
        nowIso(ctx),
      );
    return true;
  });
}

/**
 * Read every image of the revision that has no OCR result yet. A stored
 * result (an earlier attempt, an earlier job, or the user's correction) is
 * reused, so a retry never pays for the same image twice. Returns false when
 * the job was settled (waiting/retry/failed) or fenced.
 */
async function runOcrStage(
  ctx: Ctx,
  deps: WorkerDeps,
  job: Claimed,
  privacy: string,
  attachments: AttachmentRow[],
  log: Logger,
): Promise<boolean> {
  const pending = attachments.filter((a) => effectiveOcrRun(ctx, a.id) === null);
  if (pending.length === 0) return true;
  const resolved = resolveTargets(ctx, "ocr", privacy);
  if ("error" in resolved) {
    // No vision model: the images stay stored, nothing is sent to a text-only model (docs/04 §2).
    settleJob(ctx, job, "waiting_configuration", { code: resolved.error.code, message: resolved.error.message });
    log.warn("job_waiting_configuration", { error_code: resolved.error.code, stage: "ocr" });
    return false;
  }
  const prompt = deps.ocrPrompt ?? loadOcrPrompt();
  for (const attachment of pending) {
    const out = await ocrOne(ctx, deps, job, resolved.targets, prompt, attachment);
    if (out.kind === "provider_error") {
      log.warn("ocr_call_failed", { attachment_id: attachment.id, error_code: out.error.code });
      settleProviderFailure(ctx, deps, job, out.error);
      return false;
    }
    if (out.kind === "invalid") {
      settleJob(ctx, job, "failed", {
        code: "invalid_output",
        message: `Model OCR trả về kết quả không hợp lệ sau 1 lần sửa: ${out.problems.slice(0, 3).join("; ")}`.slice(0, 500),
      });
      log.warn("job_failed_invalid_ocr", { attachment_id: attachment.id });
      return false;
    }
    if (!commitOcrRun(ctx, job, attachment, out.target, prompt.version, out.image)) {
      log.warn("job_commit_fenced", { stage: "ocr" });
      return false;
    }
    log.info("ocr_stored", { attachment_id: attachment.id, status: out.image.status, uncertain: out.image.uncertainties.length });
  }
  return true;
}

/** Effective OCR text of each image, for the prompt and for the policy gate. */
function ocrSourcesOf(ctx: Ctx, attachments: AttachmentRow[]): { prompt: OcrSource[]; evidence: OcrEvidenceSource[] } {
  const prompt: OcrSource[] = [];
  const evidence: OcrEvidenceSource[] = [];
  for (const a of attachments) {
    const run = effectiveOcrRun(ctx, a.id);
    if (!run) continue;
    const uncertain = [
      ...run.uncertainties.map((u) => ({ fragment: u.fragment, alternatives: u.alternatives })),
      ...run.blocks.filter((b) => b.uncertain).map((b) => ({ fragment: b.text, alternatives: [] as string[] })),
    ].filter((u) => u.fragment.trim().length > 0);
    const position = a.position ?? 0;
    prompt.push({
      sourceId: run.id,
      imagePosition: position,
      status: run.status,
      text: run.text,
      uncertainFragments: uncertain.map((u) => u.fragment),
    });
    evidence.push({ runId: run.id, imagePosition: position, status: run.status, text: run.text, uncertain });
  }
  return { prompt, evidence };
}

/**
 * Process one claimed job end to end: OCR of the revision's images (when
 * any), then the information step over memo text + OCR text. Every outcome
 * is written with the fencing token, so a run whose lease was reclaimed
 * writes nothing.
 */
export async function processJob(deps: WorkerDeps, job: Claimed): Promise<void> {
  const ctx: Ctx = { db: deps.db, clock: deps.clock };
  const log = deps.logger.child({ job_id: job.id });
  const beat = setInterval(() => heartbeat(ctx, job), deps.heartbeatMs ?? HEARTBEAT_MS);
  try {
    const loaded = loadRevision(ctx, job.revisionId);
    const attachments = attachmentsOfRevision(ctx, job.revisionId);
    if (attachments.length > 0 && !(await runOcrStage(ctx, deps, job, loaded.privacy, attachments, log))) return;
    const ocr = ocrSourcesOf(ctx, attachments);
    const rev: RevisionInfo & { capturedAt: string; privacy: string } = { ...loaded, ocr: ocr.evidence };
    await runInformationStage(ctx, deps, job, rev, ocr.prompt, log);
  } catch (err) {
    log.error("job_crashed", { error: err instanceof Error ? err.message : String(err) });
    settleJob(ctx, job, "failed", { code: "internal_error", message: "Lỗi nội bộ khi xử lý memo." });
  } finally {
    clearInterval(beat);
  }
}

async function runInformationStage(
  ctx: Ctx,
  deps: WorkerDeps,
  job: Claimed,
  rev: RevisionInfo & { capturedAt: string; privacy: string },
  ocrSources: OcrSource[],
  log: Logger,
): Promise<void> {
  const prompt = deps.prompt ?? loadInformationPrompt();
  const candidates = loadCandidates(ctx, rev.capturedAt);
  const commit = (proposal: ProposalEnvelope, target: Target | null): void => {
    try {
      const summary = applyProposal(ctx, {
        jobId: job.id,
        fencingToken: job.fencingToken,
        revision: rev,
        proposal,
        candidates,
        promptVersion: prompt.version,
        modelId: target?.modelId ?? null,
        connectionId: target?.connectionId ?? null,
      });
      log.info("job_succeeded", { proposal_id: summary.proposalId, state: summary.state, applied: summary.applied });
    } catch (err) {
      if (err instanceof StaleJobError) {
        log.warn("job_commit_fenced", {});
        return;
      }
      throw err;
    }
  };

  if (rev.text.trim().length === 0 && ocrSources.every((o) => o.text.trim().length === 0)) {
    // Images only and none readable: nothing to extract, no model call.
    commit({ schema_version: "1.0", source_revision_id: rev.id, actions: [] }, null);
    return;
  }

  const resolved = resolveTargets(ctx, "information", rev.privacy);
  if ("error" in resolved) {
    settleJob(ctx, job, "waiting_configuration", { code: resolved.error.code, message: resolved.error.message });
    log.warn("job_waiting_configuration", { error_code: resolved.error.code });
    return;
  }

  const settings = loadSettings(ctx);
  const messages = buildInformationMessages(prompt, {
    revisionId: rev.id,
    text: rev.text,
    ocrSources,
    capturedAt: rev.capturedAt,
    timezone: rev.timezone,
    capturedLocal: formatCapturedLocal(rev.capturedAt, rev.timezone),
    dateOnlyReminderTime: settings.dateOnlyTime,
    candidates,
  });
  const binding = getRole(ctx, "information");
  let lastError: ProviderError | null = null;
  for (const target of resolved.targets) {
    let client: OpenAiCompatibleClient;
    try {
      client = new OpenAiCompatibleClient(resolveConnection(ctx, deps.ai, target.connectionId), deps.ai.transport);
    } catch (err) {
      lastError = err instanceof ProviderError ? err : new ProviderError("not_configured", "Kết nối AI không dùng được.");
      continue;
    }
    const call = async (msgs: typeof messages, purpose: "extract" | "repair") => {
      const out = await client.chat({
        model: target.modelId,
        messages: msgs,
        maxTokens: binding?.max_tokens ?? 2048,
        temperature: binding?.temperature ?? 0.1,
        jsonSchema: { name: "personalass_proposal", schema: proposalJsonSchema },
      });
      recordRun(ctx, job, target, prompt.version, purpose, "ok", { usage: out.usage, latencyMs: out.latencyMs });
      return out.content;
    };
    let content: string;
    try {
      content = await call(messages, "extract");
    } catch (err) {
      lastError = asProviderError(err, "Lỗi khi gọi provider.");
      recordRun(ctx, job, target, prompt.version, "extract", "provider_error", { errorCode: lastError.code });
      log.warn("provider_call_failed", { connection_id: target.connectionId, error_code: lastError.code });
      // Retryable or configuration errors: try the next allowed target.
      if (isRetryable(lastError.code) || needsConfiguration(lastError.code)) continue;
      break;
    }

    let parsed = parseModelOutput(content, rev.id);
    if (!parsed.ok) {
      recordRun(ctx, job, target, prompt.version, "extract", "invalid_output", { errorCode: "invalid_output" });
      // One bounded repair attempt, then a clear failure (A09).
      try {
        const repaired = await call(buildRepairMessages(messages, content, parsed.problems), "repair");
        parsed = parseModelOutput(repaired, rev.id);
      } catch (err) {
        lastError = asProviderError(err, "Lỗi khi gọi provider.");
        recordRun(ctx, job, target, prompt.version, "repair", "provider_error", { errorCode: lastError.code });
        if (isRetryable(lastError.code) || needsConfiguration(lastError.code)) continue;
        break;
      }
      if (!parsed.ok) {
        recordRun(ctx, job, target, prompt.version, "repair", "invalid_output", { errorCode: "invalid_output" });
        settleJob(ctx, job, "failed", {
          code: "invalid_output",
          message: `Model trả về proposal không hợp lệ sau 1 lần sửa: ${parsed.problems.slice(0, 3).join("; ")}`.slice(0, 500),
        });
        log.warn("job_failed_invalid_output", {});
        return;
      }
    }
    commit(parsed.proposal, target);
    return;
  }
  settleProviderFailure(ctx, deps, job, lastError ?? new ProviderError("unavailable", "Không gọi được provider nào."));
}

function maxAttempts(ctx: Ctx, jobId: string): number {
  const row = ctx.db.prepare("SELECT max_attempts FROM jobs WHERE id = ?").get(jobId) as Row;
  return Number(row.max_attempts);
}

/** Claim and process at most one job. Returns true when a job was processed. */
export async function runWorkerOnce(deps: WorkerDeps): Promise<boolean> {
  const ctx: Ctx = { db: deps.db, clock: deps.clock };
  const job = claimNextJob(ctx, deps.workerId ?? "worker");
  if (!job) return false;
  await processJob(deps, job);
  return true;
}

/**
 * Background loop, concurrency 1 (docs/02 §4). The timer only wakes a
 * database query; all work state lives in the jobs table.
 */
export function startWorker(deps: WorkerDeps, pollMs = 2000): { stop: () => Promise<void>; wake: () => void } {
  const workerDeps = { ...deps, workerId: deps.workerId ?? `worker-${randomUUID().slice(0, 8)}` };
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<void> | null = null;

  const loop = async (): Promise<void> => {
    timer = null;
    if (stopped) return;
    try {
      while (!stopped && (await runWorkerOnce(workerDeps))) {
        // drain due jobs one by one
      }
    } catch (err) {
      deps.logger.error("worker_loop_failed", { error: err instanceof Error ? err.message : String(err) });
    }
    if (!stopped) timer = setTimeout(kick, pollMs);
  };
  const kick = (): void => {
    if (stopped || running) return;
    if (timer) clearTimeout(timer);
    running = loop().finally(() => {
      running = null;
    });
  };
  kick();
  return {
    wake: kick,
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      // Stop claiming; an in-flight call keeps its lease and is reclaimed
      // after expiry if the process exits first (docs/06 §3).
      if (running) await Promise.race([running, new Promise((r) => setTimeout(r, 5000).unref())]);
    },
  };
}
