import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import type { AttachmentUploadReceipt, OcrRun } from "@personalass/contracts";
import type { Config, DataPaths } from "../config.js";
import { DomainError, OWNER_ID, nowIso, type Ctx, type Row } from "../domain/core.js";

/** Name used by the spec for the paths type; the config module calls it DataPaths. */
export type AppPaths = DataPaths;

export type AttachmentRow = {
  id: string;
  memo_revision_id: string | null;
  position: number | null;
  mime: string;
  bytes: number;
  width: number;
  height: number;
  sha256: string;
  relative_path: string;
  derived_path: string;
  derived_mime: string;
  derived_width: number;
  derived_height: number;
  created_at: string;
};

export type AttachmentLimits = {
  maxBytes: number;
  maxPixels: number;
  maxImages: number;
  tokenTtlMinutes: number;
  derivedMaxEdge: number;
};

export function attachmentLimits(config: Config): AttachmentLimits {
  return {
    maxBytes: config.MAX_UPLOAD_BYTES,
    maxPixels: config.MAX_IMAGE_PIXELS,
    maxImages: config.MAX_IMAGES_PER_MEMO,
    tokenTtlMinutes: config.ATTACHMENT_TOKEN_TTL_MINUTES,
    derivedMaxEdge: config.DERIVED_IMAGE_MAX_EDGE,
  };
}

type Kind = { mime: "image/jpeg" | "image/png" | "image/webp"; ext: string; format: string };

const ATTACHMENT_COLUMNS =
  "id, memo_revision_id, position, mime, bytes, width, height, sha256, relative_path, derived_path, derived_mime, derived_width, derived_height, created_at";

const SAFE_FILE_NAME = /^[0-9a-f-]{36}\.(jpg|png|webp)$/;

/** Detect the real image type from the magic bytes (never from the client's claim). */
export function sniffImage(buf: Buffer): Kind | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { mime: "image/jpeg", ext: "jpg", format: "jpeg" };
  }
  if (
    buf.length >= 8 &&
    buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return { mime: "image/png", ext: "png", format: "png" };
  }
  if (buf.length >= 12 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") {
    return { mime: "image/webp", ext: "webp", format: "webp" };
  }
  return null;
}

/** Resolve a stored file name under `dir`; refuses anything that is not a plain generated name. */
export function resolveInside(dir: string, name: string): string {
  if (!SAFE_FILE_NAME.test(name)) throw new DomainError("NOT_FOUND", "Ảnh không tồn tại.");
  const base = path.resolve(dir);
  const full = path.resolve(base, name);
  if (path.dirname(full) !== base) throw new DomainError("NOT_FOUND", "Ảnh không tồn tại.");
  return full;
}

const sha256Hex = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");
export const hashToken = (token: string): string => sha256Hex(token);

const bad = (message: string): DomainError => new DomainError("BAD_REQUEST", message, { file: message });

export type StageInput = {
  data: Buffer;
  /** Content-Type declared by the multipart part. */
  declaredMime: string;
  /** Client file name; kept as metadata only. */
  originalName: string | null;
};

/**
 * Validate an upload, write the original and the derived copy, and insert a
 * staged row (docs/01 §3, docs/06 §1). No job is created.
 */
export async function stageUpload(
  ctx: Ctx,
  paths: AppPaths,
  limits: AttachmentLimits,
  input: StageInput,
): Promise<AttachmentUploadReceipt> {
  const { data } = input;
  if (data.length === 0) throw bad("Tệp ảnh trống.");
  if (data.length > limits.maxBytes) {
    throw new DomainError("PAYLOAD_TOO_LARGE", "Ảnh quá lớn.", { file: "Ảnh vượt giới hạn dung lượng." });
  }
  const kind = sniffImage(data);
  const declared = input.declaredMime.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!kind || kind.mime !== declared) {
    throw bad("Tệp không phải ảnh JPEG, PNG hoặc WebP hợp lệ (loại tệp không khớp nội dung).");
  }

  let width: number;
  let height: number;
  let derived: Buffer;
  let derivedWidth: number;
  let derivedHeight: number;
  try {
    const meta = await sharp(data, { limitInputPixels: limits.maxPixels, failOn: "error" }).metadata();
    if (meta.format !== kind.format || !meta.width || !meta.height) {
      throw bad("Nội dung ảnh không khớp loại tệp.");
    }
    if (meta.width * meta.height > limits.maxPixels) {
      throw bad(`Ảnh quá lớn (tối đa ${Math.round(limits.maxPixels / 1_000_000)} megapixel).`);
    }
    // EXIF orientation 5-8 swaps the displayed width and height.
    const swapped = (meta.orientation ?? 1) >= 5;
    width = swapped ? meta.height : meta.width;
    height = swapped ? meta.width : meta.height;
    // A real full decode: also proves the pixel data is readable. sharp drops
    // EXIF/ICC/XMP unless asked to keep them, so the derived copy is clean.
    const out = await sharp(data, { limitInputPixels: limits.maxPixels, failOn: "error" })
      .rotate()
      .resize({ width: limits.derivedMaxEdge, height: limits.derivedMaxEdge, fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 85 })
      .toBuffer({ resolveWithObject: true });
    derived = out.data;
    derivedWidth = out.info.width;
    derivedHeight = out.info.height;
  } catch (err) {
    if (err instanceof DomainError) throw err;
    throw bad("Không đọc được ảnh (tệp hỏng hoặc quá lớn).");
  }

  const id = randomUUID();
  const originalName = `${id}.${kind.ext}`;
  const derivedName = `${id}.jpg`;
  const originalFile = resolveInside(paths.attachmentsOriginal, originalName);
  const derivedFile = resolveInside(paths.attachmentsDerived, derivedName);
  const written: string[] = [];
  try {
    fs.mkdirSync(paths.attachmentsOriginal, { recursive: true });
    fs.mkdirSync(paths.attachmentsDerived, { recursive: true });
    fs.writeFileSync(originalFile, data, { flag: "wx" });
    written.push(originalFile);
    fs.writeFileSync(derivedFile, derived, { flag: "wx" });
    written.push(derivedFile);

    const token = randomBytes(32).toString("base64url");
    const now = nowIso(ctx);
    const expires = new Date(ctx.clock().getTime() + limits.tokenTtlMinutes * 60_000).toISOString();
    const sha = sha256Hex(data);
    ctx.db
      .prepare(
        `INSERT INTO attachments (id, owner_id, memo_revision_id, position, token_hash, token_expires_at,
           relative_path, derived_path, original_name, mime, bytes, sha256, width, height,
           derived_mime, derived_bytes, derived_width, derived_height, created_at, updated_at)
         VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'image/jpeg', ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        OWNER_ID,
        hashToken(token),
        expires,
        originalName,
        derivedName,
        input.originalName ? input.originalName.slice(0, 255) : null,
        kind.mime,
        data.length,
        sha,
        width,
        height,
        derived.length,
        derivedWidth,
        derivedHeight,
        now,
        now,
      );
    return {
      attachment_id: id,
      attachment_token: token,
      expires_at: expires,
      mime: kind.mime,
      bytes: data.length,
      width,
      height,
      sha256: sha,
    };
  } catch (err) {
    for (const f of written) removeQuietly(f);
    throw err;
  }
}

function removeQuietly(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // best effort: an orphan file is harmless and never served
  }
}

/**
 * Bind staged uploads to a revision, in order. Must run inside the memo
 * transaction. Unknown, expired or already-used tokens fail with 422 and a
 * field error `attachment_tokens.<index>`.
 */
export function bindAttachments(ctx: Ctx, revisionId: string, tokens: readonly string[]): string[] {
  const now = nowIso(ctx);
  const ids: string[] = [];
  tokens.forEach((token, index) => {
    const row = ctx.db
      .prepare(
        `SELECT id, memo_revision_id, token_expires_at FROM attachments
         WHERE token_hash = ? AND owner_id = ?`,
      )
      .get(hashToken(token), OWNER_ID) as Row | undefined;
    let problem: string | null = null;
    if (!row) problem = "Ảnh không tồn tại hoặc mã tải lên không hợp lệ. Hãy tải ảnh lên lại.";
    else if (row.memo_revision_id !== null) problem = "Ảnh này đã được dùng cho một memo khác.";
    else if (String(row.token_expires_at) <= now) problem = "Ảnh đã hết hạn chờ. Hãy tải ảnh lên lại.";
    if (problem !== null || !row) {
      throw new DomainError("UNPROCESSABLE_ENTITY", "Không thể đính kèm ảnh.", {
        [`attachment_tokens.${index}`]: problem ?? "Ảnh không hợp lệ.",
      });
    }
    const res = ctx.db
      .prepare(
        "UPDATE attachments SET memo_revision_id = ?, position = ?, updated_at = ? WHERE id = ? AND memo_revision_id IS NULL",
      )
      .run(revisionId, index, now, String(row.id));
    if (Number(res.changes) !== 1) {
      throw new DomainError("UNPROCESSABLE_ENTITY", "Không thể đính kèm ảnh.", {
        [`attachment_tokens.${index}`]: "Ảnh này đã được dùng cho một memo khác.",
      });
    }
    ids.push(String(row.id));
  });
  return ids;
}

/** Bound attachments of a revision, ordered by position. */
export function attachmentsOfRevision(ctx: Ctx, revisionId: string): AttachmentRow[] {
  return ctx.db
    .prepare(`SELECT ${ATTACHMENT_COLUMNS} FROM attachments WHERE memo_revision_id = ? ORDER BY position`)
    .all(revisionId) as unknown as AttachmentRow[];
}

/** Read the derived (EXIF-free, downscaled JPEG) bytes; path resolved under paths.attachmentsDerived with a traversal check. */
export function readDerivedImage(paths: AppPaths, a: Pick<AttachmentRow, "derived_path">): Buffer {
  return fs.readFileSync(resolveInside(paths.attachmentsDerived, a.derived_path));
}

/** Original bytes of a BOUND attachment for serving; staged or unknown ids are 404. */
export function readOriginalForServing(
  ctx: Ctx,
  paths: AppPaths,
  id: string,
): { mime: string; ext: string; data: Buffer } {
  const row = ctx.db
    .prepare("SELECT relative_path, mime FROM attachments WHERE id = ? AND owner_id = ? AND memo_revision_id IS NOT NULL")
    .get(id, OWNER_ID) as Row | undefined;
  if (!row) throw new DomainError("NOT_FOUND", "Ảnh không tồn tại.");
  const name = String(row.relative_path);
  const file = resolveInside(paths.attachmentsOriginal, name);
  let data: Buffer;
  try {
    data = fs.readFileSync(file);
  } catch {
    throw new DomainError("NOT_FOUND", "Tệp ảnh không còn trên máy chủ.");
  }
  return { mime: String(row.mime), ext: path.extname(name).slice(1), data };
}

/** Map an ocr_runs row to the contracts OcrRun DTO. */
export function toOcrRun(row: Row): OcrRun {
  return {
    id: String(row.id),
    attachment_id: String(row.attachment_id),
    author: row.author as OcrRun["author"],
    status: row.status as OcrRun["status"],
    text: String(row.extracted_text),
    blocks: JSON.parse(String(row.blocks_json ?? "[]")) as OcrRun["blocks"],
    uncertainties: JSON.parse(String(row.uncertainties_json ?? "[]")) as OcrRun["uncertainties"],
    model_id: (row.model_id as string | null) ?? null,
    supersedes_run_id: (row.supersedes_run_id as string | null) ?? null,
    created_at: String(row.created_at),
  };
}

/** Newest ocr_runs row for an attachment, or null. */
export function effectiveOcrRun(ctx: Ctx, attachmentId: string): OcrRun | null {
  const row = ctx.db
    .prepare("SELECT * FROM ocr_runs WHERE attachment_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
    .get(attachmentId) as Row | undefined;
  return row ? toOcrRun(row) : null;
}

/** Delete expired staged uploads and their files. Bound attachments are never touched. */
export function purgeExpiredUploads(ctx: Ctx, paths: AppPaths): number {
  const now = nowIso(ctx);
  const rows = ctx.db
    .prepare("SELECT id, relative_path, derived_path FROM attachments WHERE memo_revision_id IS NULL AND token_expires_at <= ?")
    .all(now) as Row[];
  let purged = 0;
  for (const r of rows) {
    const res = ctx.db
      .prepare("DELETE FROM attachments WHERE id = ? AND memo_revision_id IS NULL")
      .run(String(r.id));
    if (Number(res.changes) !== 1) continue;
    purged += 1;
    try {
      removeQuietly(resolveInside(paths.attachmentsOriginal, String(r.relative_path)));
      removeQuietly(resolveInside(paths.attachmentsDerived, String(r.derived_path)));
    } catch {
      // unexpected stored name: leave the file alone
    }
  }
  return purged;
}
