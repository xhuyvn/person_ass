import type { Clarification, Job, ProposalAction } from "@personalass/contracts";
import { formatDate, formatInstant, localDateTimeToIso, parseDateInput } from "./format";

/** Display helpers for AI processing results (pure, unit-tested). */

export type JobView = { text: string; tone: "muted" | "ok" | "warn" | "error"; active: boolean; canReprocess: boolean; needsSettings: boolean };

export function describeJob(job: Job | null): JobView {
  if (!job) return { text: "Chỉ lưu, không xử lý AI.", tone: "muted", active: false, canReprocess: true, needsSettings: false };
  switch (job.state) {
    case "queued":
      return { text: "Đang chờ xử lý…", tone: "muted", active: true, canReprocess: false, needsSettings: false };
    case "running":
      return { text: `Đang xử lý (lần ${job.attempt}/${job.max_attempts})…`, tone: "muted", active: true, canReprocess: false, needsSettings: false };
    case "retry_wait":
      return {
        text: `Provider lỗi tạm thời (${job.error_message ?? job.error_code ?? "?"}). Thử lại lúc ${formatInstant(job.run_after)}.`,
        tone: "warn",
        active: true,
        canReprocess: false,
        needsSettings: false,
      };
    case "waiting_configuration":
      return {
        text: `Chờ cấu hình AI: ${(job.error_message ?? "chưa có kết nối/model").replace(/\.+$/, "")}. Memo đã được lưu an toàn.`,
        tone: "warn",
        active: false,
        canReprocess: false,
        needsSettings: true,
      };
    case "succeeded":
      return { text: "Đã xử lý.", tone: "ok", active: false, canReprocess: true, needsSettings: false };
    case "failed":
      return { text: `Xử lý thất bại: ${job.error_message ?? job.error_code ?? "không rõ"}. Memo vẫn còn.`, tone: "error", active: false, canReprocess: true, needsSettings: false };
    case "cancelled":
      return { text: "Đã hủy xử lý.", tone: "muted", active: false, canReprocess: true, needsSettings: false };
  }
}

const ENTITY_LABEL: Record<string, string> = {
  task: "Việc",
  appointment: "Lịch hẹn",
  note: "Ghi chú",
  person: "Người",
  asset: "Tài sản",
  interaction: "Tương tác",
  maintenance_record: "Bảo trì",
};

const STATUS_LABEL: Record<ProposalAction["status"], string> = {
  applied: "đã áp dụng",
  needs_clarification: "cần bạn trả lời",
  waiting_dependency: "chờ mục khác",
  rejected: "bị từ chối",
  duplicate: "đã có từ trước",
  dismissed: "đã bỏ qua",
};

const REASON_LABEL: Record<string, string> = {
  evidence_mismatch: "trích dẫn không có trong memo",
  entity_type_not_supported_yet: "loại này chưa được hỗ trợ ở phiên bản hiện tại",
  unknown_target: "không tìm thấy mục cần sửa",
  target_missing: "mục cần sửa không còn",
  note_update_not_supported: "chưa hỗ trợ sửa ghi chú tự động",
  undone: "đã hoàn tác",
  already_applied: "đã áp dụng ở lần xử lý trước",
  dismissed_by_user: "bạn đã bỏ qua",
};

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** "Lịch hẹn · Họp với Minh · 22/10/2026 09:00"; updates name their target when known. */
export function describeAction(a: ProposalAction, targetTitle?: string | null): string {
  const f = a.fields;
  const parts = [`${ENTITY_LABEL[a.entity_type] ?? a.entity_type}${a.operation === "update" ? " (sửa)" : ""}`];
  const title = str(f.title) ?? (a.operation === "update" ? (targetTitle ?? null) : null);
  if (title) parts.push(title);
  const when = str(f.starts_at) ?? str(f.due_at);
  const date = str(f.due_date) ?? str(f.local_date);
  if (when) parts.push(formatInstant(when));
  else if (date) parts.push(formatDate(date));
  else if (a.entity_type === "task" && a.operation === "create") parts.push("không có hạn");
  if (str(f.status)) parts.push(`→ ${String(f.status)}`);
  return parts.join(" · ");
}

export function describeStatus(a: ProposalAction): string {
  const base = STATUS_LABEL[a.status];
  if (!a.reason || a.status === "needs_clarification" || (a.status === "applied" && a.reason !== "undone")) return base;
  const reason = REASON_LABEL[a.reason] ?? (a.reason.startsWith("invalid_fields") ? "dữ liệu không hợp lệ" : a.reason.startsWith("apply_failed") ? "không áp dụng được" : a.reason);
  return a.reason === "undone" ? reason : `${base}: ${reason}`;
}

/** One undo per action group: the group id and how many applied actions it covers. */
export function undoGroups(actions: ProposalAction[]): Map<string, number> {
  const groups = new Map<string, number>();
  for (const a of actions) {
    if (a.status !== "applied" || !a.action_group_id || a.reason === "undone") continue;
    groups.set(a.action_group_id, (groups.get(a.action_group_id) ?? 0) + 1);
  }
  return groups;
}

/* ---- clarification answers ---- */

export type AnswerField = { path: string; label: string; placeholder: string };

const FIELD_INPUT: Record<string, { label: string; placeholder: string }> = {
  starts_at: { label: "Thời gian bắt đầu", placeholder: "yyyy-mm-dd hh:mm" },
  ends_at: { label: "Thời gian kết thúc", placeholder: "yyyy-mm-dd hh:mm" },
  due_at: { label: "Hạn (có giờ)", placeholder: "yyyy-mm-dd hh:mm" },
  planned_at: { label: "Dự định làm lúc", placeholder: "yyyy-mm-dd hh:mm" },
  due_date: { label: "Hạn (ngày)", placeholder: "dd/mm/yyyy" },
  local_date: { label: "Ngày", placeholder: "dd/mm/yyyy" },
  title: { label: "Tiêu đề", placeholder: "" },
};

/** Inputs to show for a missing_fields question. */
export function answerFields(c: Clarification, action: ProposalAction | undefined): AnswerField[] {
  const paths = (c.field_path ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0 && p in FIELD_INPUT);
  if (paths.length === 0) paths.push(action?.entity_type === "task" ? "due_date" : "starts_at");
  return [...new Set(paths)].map((path) => ({ path, ...(FIELD_INPUT[path] as { label: string; placeholder: string }) }));
}

/** Convert typed values to API field values; returns an error text when a value is invalid. */
export function buildAnswerFields(fields: AnswerField[], values: Record<string, string>): { fields: Record<string, string> } | { error: string } {
  const out: Record<string, string> = {};
  for (const f of fields) {
    const raw = (values[f.path] ?? "").trim();
    if (!raw) return { error: `Nhập ${f.label.toLowerCase()}.` };
    if (f.placeholder === "yyyy-mm-dd hh:mm") {
      const iso = localDateTimeToIso(raw);
      if (!iso) return { error: `${f.label} phải dạng yyyy-mm-dd hh:mm.` };
      out[f.path] = iso;
    } else if (f.placeholder === "dd/mm/yyyy") {
      const d = parseDateInput(raw);
      if (!d) return { error: `${f.label} phải dạng dd/mm/yyyy.` };
      out[f.path] = d;
    } else {
      out[f.path] = raw;
    }
  }
  return { fields: out };
}
