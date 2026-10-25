import type { OcrCorrection, OcrCorrectionResult, OcrRun, SourceDetail } from "@personalass/contracts";
import { latestJobForRevision, reprocessMemo } from "../jobs/worker.js";
import { effectiveOcrRun, toOcrRun } from "../storage/attachments.js";
import { DomainError, OWNER_ID, newId, notFound, nowIso, writeAudit, type Ctx, type Row } from "./core.js";

/**
 * OCR corrections and source lookup (docs/04 §2, docs/03 §3). A correction is
 * a new immutable run authored by the user; it never rewrites the AI run, and
 * items already created keep pointing at the run they quoted.
 */

const ACTIVE_STATES = new Set(["queued", "running", "retry_wait"]);

function boundAttachment(ctx: Ctx, id: string): Row {
  const row = ctx.db
    .prepare(
      `SELECT a.id, a.memo_revision_id, r.memo_id, m.current_revision_id, m.archived_at
       FROM attachments a JOIN memo_revisions r ON r.id = a.memo_revision_id JOIN memos m ON m.id = r.memo_id
       WHERE a.id = ? AND a.owner_id = ?`,
    )
    .get(id, OWNER_ID) as Row | undefined;
  if (!row) throw notFound("Ảnh");
  return row;
}

export function listOcrRuns(ctx: Ctx, attachmentId: string): OcrRun[] {
  boundAttachment(ctx, attachmentId);
  const rows = ctx.db
    .prepare("SELECT * FROM ocr_runs WHERE attachment_id = ? AND owner_id = ? ORDER BY created_at DESC, rowid DESC")
    .all(attachmentId, OWNER_ID) as Row[];
  return rows.map(toOcrRun);
}

/** POST /attachments/:id/ocr-corrections. Caller owns the transaction. */
export function correctOcr(ctx: Ctx, attachmentId: string, input: OcrCorrection): OcrCorrectionResult {
  const att = boundAttachment(ctx, attachmentId);
  if (att.archived_at) throw new DomainError("UNPROCESSABLE_ENTITY", "Memo đã được lưu trữ; không sửa chữ ảnh được.");
  const current = effectiveOcrRun(ctx, attachmentId);
  if ((current?.id ?? null) !== input.expected_run_id) {
    throw new DomainError("CONFLICT", "Chữ của ảnh vừa được cập nhật ở nơi khác. Tải lại rồi sửa tiếp.");
  }
  const text = input.text.normalize("NFC");
  const id = newId();
  ctx.db
    .prepare(
      `INSERT INTO ocr_runs (id, owner_id, attachment_id, job_id, author, supersedes_run_id, status, extracted_text,
         blocks_json, uncertainties_json, created_at)
       VALUES (?, ?, ?, NULL, 'user', ?, 'readable', ?, ?, '[]', ?)`,
    )
    .run(id, OWNER_ID, attachmentId, current?.id ?? null, text, JSON.stringify([{ text, kind: "paragraph", uncertain: false }]), nowIso(ctx));
  // The audit keeps run ids only; the texts stay in ocr_runs (no memo content in audit).
  writeAudit(ctx, {
    actor: "user",
    action: "ocr.correct",
    entityType: "attachment",
    entityId: attachmentId,
    before: { ocr_run_id: current?.id ?? null },
    after: { ocr_run_id: id },
  });
  const run = toOcrRun(ctx.db.prepare("SELECT * FROM ocr_runs WHERE id = ?").get(id) as Row);

  if (!input.reprocess || att.memo_revision_id !== att.current_revision_id) return { run, job: null, reprocess: "skipped" };
  const last = latestJobForRevision(ctx, String(att.memo_revision_id));
  if (last && ACTIVE_STATES.has(last.state)) return { run, job: last, reprocess: "busy" };
  return { run, job: reprocessMemo(ctx, String(att.memo_id)), reprocess: "queued" };
}

const SOURCE_TYPES = new Set(["task", "appointment", "note"]);

/** GET /sources: provenance of one item, each link resolved to the exact OCR run it quoted. */
export function sourcesOf(ctx: Ctx, entityType: string, entityId: string): SourceDetail[] {
  if (!SOURCE_TYPES.has(entityType)) throw new DomainError("BAD_REQUEST", "Loại mục không hợp lệ.", { entity_type: "task, appointment hoặc note." });
  const rows = ctx.db
    .prepare(
      `SELECT sl.*, r.memo_id, a.position AS attachment_position FROM source_links sl
       JOIN memo_revisions r ON r.id = sl.memo_revision_id
       LEFT JOIN attachments a ON a.id = sl.attachment_id
       WHERE sl.owner_id = ? AND sl.entity_type = ? AND sl.entity_id = ? ORDER BY sl.created_at, sl.rowid`,
    )
    .all(OWNER_ID, entityType, entityId) as Row[];
  return rows.map((r) => {
    const runRow = r.ocr_run_id ? (ctx.db.prepare("SELECT * FROM ocr_runs WHERE id = ?").get(String(r.ocr_run_id)) as Row | undefined) : undefined;
    const run = runRow ? toOcrRun(runRow) : null;
    const latest = run ? effectiveOcrRun(ctx, run.attachment_id) : null;
    return {
      memo_id: String(r.memo_id),
      memo_revision_id: String(r.memo_revision_id),
      quote: (r.quote as string | null) ?? null,
      field_path: (r.field_path as string | null) ?? null,
      attachment_id: (r.attachment_id as string | null) ?? null,
      attachment_position: r.attachment_position === null || r.attachment_position === undefined ? null : Number(r.attachment_position),
      ocr_run: run,
      ocr_run_is_latest: run ? latest?.id === run.id : null,
      created_at: String(r.created_at),
    };
  });
}
