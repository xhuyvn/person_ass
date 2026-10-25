import type { Attachment, OcrRun, ProposalAction, SourceDetail } from "@personalass/contracts";

/** Display and validation helpers for memo images and OCR text (pure, unit-tested). */

export const MAX_IMAGES = 10;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const ACCEPTED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

export type PickedMeta = { name: string; type: string; size: number };

/**
 * Client-side pre-check of newly picked files (the server re-validates).
 * Returns the indexes that may be added and one Vietnamese error per rejected file.
 */
export function precheckImages(existingCount: number, files: PickedMeta[]): { accepted: number[]; errors: string[] } {
  const accepted: number[] = [];
  const errors: string[] = [];
  files.forEach((f, i) => {
    const label = f.name || `Ảnh ${i + 1}`;
    if (!(ACCEPTED_IMAGE_TYPES as readonly string[]).includes(f.type)) {
      errors.push(`${label}: chỉ nhận ảnh JPEG, PNG hoặc WebP.`);
    } else if (f.size <= 0) {
      errors.push(`${label}: tệp rỗng.`);
    } else if (f.size > MAX_IMAGE_BYTES) {
      errors.push(`${label}: lớn quá 10 MB (${(f.size / 1048576).toFixed(1)} MB).`);
    } else if (existingCount + accepted.length >= MAX_IMAGES) {
      errors.push(`${label}: mỗi memo tối đa ${MAX_IMAGES} ảnh.`);
    } else {
      accepted.push(i);
    }
  });
  return { accepted, errors };
}

/* ---- OCR display ---- */

export type OcrView = {
  /** Short state label, e.g. "Đọc được". */
  status: string;
  tone: "muted" | "ok" | "warn" | "error";
  /** "AI đọc" / "Bạn đã sửa"; null when nothing was read yet. */
  author: string | null;
  text: string;
  /** Never colour-only: each line starts with a warning prefix. */
  uncertain: Array<{ line: string; fragment: string; alternatives: string[] }>;
};

const STATUS_LABEL: Record<OcrRun["status"], { text: string; tone: OcrView["tone"] }> = {
  readable: { text: "Đọc được", tone: "ok" },
  partial: { text: "Đọc được một phần", tone: "warn" },
  unreadable: { text: "Không đọc được chữ", tone: "error" },
};

export function describeOcr(run: OcrRun | null): OcrView {
  if (!run) return { status: "Chưa đọc chữ", tone: "muted", author: null, text: "", uncertain: [] };
  const st = STATUS_LABEL[run.status];
  return {
    status: st.text,
    tone: st.tone,
    author: run.author === "user" ? "Bạn đã sửa" : "AI đọc",
    text: run.text,
    uncertain: run.uncertainties.map((u) => ({
      fragment: u.fragment,
      alternatives: u.alternatives,
      line: `⚠ chưa chắc: “${u.fragment}”${u.alternatives.length > 0 ? ` (có thể là: ${u.alternatives.map((a) => `“${a}”`).join(", ")})` : ""}${u.reason ? ` · ${u.reason}` : ""}`,
    })),
  };
}

/* ---- correction result ---- */

export function describeCorrectionResult(reprocess: "queued" | "busy" | "skipped"): string {
  switch (reprocess) {
    case "queued":
      return "Đã lưu chữ đã sửa. Đang xử lý lại.";
    case "busy":
      return "Đã lưu chữ đã sửa. Memo đang được xử lý; bấm Xử lý lại sau.";
    case "skipped":
      return "Đã lưu chữ đã sửa (không xử lý lại).";
  }
}

export const CORRECTION_CONFLICT_TEXT = "Chữ vừa được cập nhật, tải lại.";

/* ---- evidence -> image number ---- */

/**
 * 1-based image numbers an action's evidence was quoted from, ascending.
 * Matches the quoted OCR run against each attachment's shown run (newest);
 * `unknown` counts evidence from an image whose run is no longer the shown one.
 */
export function evidenceImages(a: Pick<ProposalAction, "evidence">, attachments: Array<Pick<Attachment, "position" | "ocr">>): { numbers: number[]; unknown: boolean } {
  const numbers = new Set<number>();
  let unknown = false;
  for (const e of a.evidence) {
    if (!e.ocr_run_id) continue;
    const att = attachments.find((x) => x.ocr?.id === e.ocr_run_id);
    if (att) numbers.add(att.position + 1);
    else unknown = true;
  }
  return { numbers: [...numbers].sort((x, y) => x - y), unknown };
}

/** "từ ảnh #1, #3", "từ ảnh" when the run is not the shown one, or null for text-only evidence. */
export function evidenceLabel(a: Pick<ProposalAction, "evidence">, attachments: Array<Pick<Attachment, "position" | "ocr">>): string | null {
  const { numbers, unknown } = evidenceImages(a, attachments);
  if (numbers.length > 0) return `từ ảnh ${numbers.map((n) => `#${n}`).join(", ")}`;
  return unknown ? "từ ảnh" : null;
}

/* ---- source view ---- */

export type SourceView = {
  quote: string | null;
  /** "Ảnh #n" when the source comes from an image. */
  imageLabel: string | null;
  attachmentId: string | null;
  ocrText: string | null;
  note: string | null;
};

export const SOURCE_CORRECTED_NOTE = "Chữ ảnh đã được sửa sau đó";

export function describeSource(src: SourceDetail): SourceView {
  const fromImage = src.attachment_id !== null;
  return {
    quote: src.quote,
    imageLabel: fromImage && src.attachment_position !== null ? `Ảnh #${src.attachment_position + 1}` : fromImage ? "Ảnh" : null,
    attachmentId: src.attachment_id,
    ocrText: src.ocr_run ? src.ocr_run.text : null,
    note: fromImage && src.ocr_run_is_latest === false ? SOURCE_CORRECTED_NOTE : null,
  };
}

/** Entity types that have a source view. */
export function sourceEntity(a: Pick<ProposalAction, "status" | "reason" | "result_entity_type" | "result_entity_id">): { type: "task" | "appointment" | "note"; id: string } | null {
  if (a.status !== "applied" || a.reason === "undone" || !a.result_entity_id) return null;
  const t = a.result_entity_type;
  return t === "task" || t === "appointment" || t === "note" ? { type: t, id: a.result_entity_id } : null;
}

/** A file chosen by the picker, before upload. */
export type PickedFile = PickedMeta & { blob: Blob };

/** Split OCR text into plain and uncertain segments (first occurrence of each fragment, left to right). */
export function splitOcrText(text: string, fragments: string[]): Array<{ text: string; uncertain: boolean }> {
  const marks: Array<[number, number]> = [];
  for (const f of fragments) {
    if (!f) continue;
    const at = text.indexOf(f);
    if (at < 0) continue;
    const end = at + f.length;
    if (marks.some(([a, b]) => at < b && end > a)) continue;
    marks.push([at, end]);
  }
  marks.sort((x, y) => x[0] - y[0]);
  const out: Array<{ text: string; uncertain: boolean }> = [];
  let pos = 0;
  for (const [a, b] of marks) {
    if (a > pos) out.push({ text: text.slice(pos, a), uncertain: false });
    out.push({ text: text.slice(a, b), uncertain: true });
    pos = b;
  }
  if (pos < text.length) out.push({ text: text.slice(pos), uncertain: false });
  return out.length > 0 ? out : [{ text, uncertain: false }];
}

export const IMAGE_CONTENT_PATH = (attachmentId: string): string => `/api/v1/attachments/${attachmentId}/content`;
