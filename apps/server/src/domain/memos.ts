import type { ListQuery, MemoCreate, MemoDetail, MemoReceipt } from "@personalass/contracts";
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
import { assertValidTimeZone } from "./time.js";

/**
 * Save a memo as raw text + revision 1. `client_request_id` is unique per
 * owner for the memo's whole life (docs/03 §5, A07): a repeat returns the
 * same receipt and creates nothing. No AI job exists in M1 (job_id = null).
 */
export function createMemo(ctx: Ctx, input: MemoCreate): { receipt: MemoReceipt; created: boolean } {
  if (!assertValidTimeZone(input.timezone)) {
    throw new DomainError("BAD_REQUEST", "Dữ liệu không hợp lệ.", { timezone: "Múi giờ IANA không hợp lệ." });
  }
  const existing = ctx.db
    .prepare("SELECT id, current_revision_id FROM memos WHERE owner_id = ? AND client_request_id = ?")
    .get(OWNER_ID, input.client_request_id) as Row | undefined;
  if (existing) {
    return {
      created: false,
      receipt: {
        memo_id: String(existing.id),
        revision_id: String(existing.current_revision_id),
        job_id: null,
        state: "saved",
      },
    };
  }

  const memoId = newId();
  const revisionId = newId();
  const now = nowIso(ctx);
  ctx.db
    .prepare(
      `INSERT INTO memos (id, owner_id, client_request_id, current_revision_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(memoId, OWNER_ID, input.client_request_id, revisionId, now, now);
  ctx.db
    .prepare(
      `INSERT INTO memo_revisions (id, memo_id, revision_no, raw_text, captured_at, timezone, input_kind,
         created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?, 'text', ?, ?)`,
    )
    .run(revisionId, memoId, input.text, input.captured_at, input.timezone, now, now);
  writeAudit(ctx, {
    action: "memo.create",
    entityType: "memo",
    entityId: memoId,
    after: { revision_id: revisionId, input_kind: "text" },
  });
  return {
    created: true,
    receipt: { memo_id: memoId, revision_id: revisionId, job_id: null, state: "saved" },
  };
}

export function getMemo(ctx: Ctx, id: string): MemoDetail {
  const memo = ctx.db.prepare("SELECT * FROM memos WHERE id = ? AND owner_id = ?").get(id, OWNER_ID) as
    | Row
    | undefined;
  if (!memo) throw notFound("Memo");
  const rev = ctx.db
    .prepare("SELECT * FROM memo_revisions WHERE id = ?")
    .get(String(memo.current_revision_id)) as Row | undefined;
  const sources = ctx.db
    .prepare(
      `SELECT sl.entity_type, sl.entity_id, sl.memo_revision_id, sl.quote
       FROM source_links sl JOIN memo_revisions r ON r.id = sl.memo_revision_id
       WHERE r.memo_id = ? AND sl.owner_id = ? ORDER BY sl.created_at`,
    )
    .all(id, OWNER_ID) as Row[];
  return {
    id: String(memo.id),
    current_revision_id: (memo.current_revision_id as string | null) ?? null,
    archived_at: (memo.archived_at as string | null) ?? null,
    version: Number(memo.version),
    created_at: String(memo.created_at),
    updated_at: String(memo.updated_at),
    revision: rev
      ? {
          id: String(rev.id),
          revision_no: Number(rev.revision_no),
          raw_text: String(rev.raw_text),
          captured_at: String(rev.captured_at),
          timezone: String(rev.timezone),
          input_kind: String(rev.input_kind),
        }
      : null,
    sources: sources.map((r) => ({
      entity_type: String(r.entity_type),
      entity_id: String(r.entity_id),
      memo_revision_id: (r.memo_revision_id as string | null) ?? null,
      quote: (r.quote as string | null) ?? null,
    })),
  };
}

export function listMemos(ctx: Ctx, q: ListQuery): Page<MemoDetail> {
  const cursor = decodeCursor(q.cursor);
  const args: unknown[] = [OWNER_ID];
  let where = "owner_id = ? AND archived_at IS NULL";
  if (cursor) {
    where += " AND (created_at < ? OR (created_at = ? AND id < ?))";
    args.push(cursor.createdAt, cursor.createdAt, cursor.id);
  }
  args.push(q.limit + 1);
  const rows = ctx.db
    .prepare(`SELECT id, created_at FROM memos WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ?`)
    .all(...(args as never[])) as Row[];
  const { rows: kept, next } = pageRows(rows, q.limit);
  return { items: kept.map((r) => getMemo(ctx, String(r.id))), next_cursor: next };
}
