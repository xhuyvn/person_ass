import {
  aiConnectionListSchema,
  aiConnectionSchema,
  aiConnectionTestResultSchema,
  aiModelListSchema,
  aiRoleListSchema,
  attachmentUploadReceiptSchema,
  apiErrorSchema,
  clarificationResultSchema,
  jobSchema,
  memoDetailSchema,
  ocrCorrectionResultSchema,
  ocrRunSchema,
  sourceDetailSchema,
  undoResultSchema,
  type AiConnection,
  type AiConnectionCreate,
  type AiConnectionPatch,
  type AiConnectionTestResult,
  type AiModelList,
  type AiRoleBinding,
  type AiRoleBindingInput,
  type ClarificationAnswer,
  type ClarificationResult,
  type AttachmentUploadReceipt,
  type Job,
  type OcrCorrectionResult,
  type OcrRun,
  type SourceDetail,
  type MemoDetail,
  type UndoResult,
  appointmentSchema,
  memoReceiptSchema,
  noteSchema,
  notificationSchema,
  paginationSchema,
  taskSchema,
  type Appointment,
  type MemoReceipt,
  type Note,
  type Notification,
  type Task,
} from "@personalass/contracts";
import type { z } from "zod";

/** Display-safe error from the backend envelope or the network. */
export class ApiClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly fieldErrors?: Record<string, string>,
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

export type ApiOptions = {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  newKey?: () => string;
};

const randomKey = (): string =>
  `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}${Math.random().toString(36).slice(2, 10)}`;

export function newUuid(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  // Fallback for non-secure contexts (plain http on a LAN address).
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = Math.floor(Math.random() * 16);
    return (ch === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export function createApi(options: ApiOptions) {
  const base = options.baseUrl.replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 10000;
  const key = options.newKey ?? randomKey;

  async function request<S extends z.ZodType>(
    method: string,
    path: string,
    schema: S,
    body?: unknown,
    idempotencyKey?: string,
    /** Longer deadline for calls that wait on a provider (connection test). */
    timeoutOverrideMs?: number,
  ): Promise<z.output<S>> {
    const isForm = typeof FormData !== "undefined" && body instanceof FormData;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutOverrideMs ?? timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(`${base}/api/v1${path}`, {
        method,
        headers: {
          accept: "application/json",
          // FormData: the runtime sets the multipart content-type and boundary.
          ...(body === undefined || isForm ? {} : { "content-type": "application/json" }),
          ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
        },
        ...(body === undefined ? {} : { body: isForm ? (body as FormData) : JSON.stringify(body) }),
        signal: controller.signal,
      });
    } catch {
      throw new ApiClientError("Không kết nối được máy chủ. Backend có đang chạy không?", 0);
    } finally {
      clearTimeout(timer);
    }

    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      raw = undefined;
    }
    if (!response.ok) {
      const env = apiErrorSchema.safeParse(raw);
      if (env.success) {
        throw new ApiClientError(env.data.error.message, response.status, env.data.error.field_errors);
      }
      throw new ApiClientError(`Máy chủ trả về lỗi HTTP ${response.status}.`, response.status);
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      throw new ApiClientError("Máy chủ trả về dữ liệu không đúng lược đồ.", response.status);
    }
    return parsed.data;
  }

  const taskPage = paginationSchema(taskSchema);
  const noteGroup = paginationSchema(noteSchema);
  const apptPage = paginationSchema(appointmentSchema);
  const notifPage = paginationSchema(notificationSchema);
  const memoPage = paginationSchema(memoDetailSchema);
  const ocrRunPage = paginationSchema(ocrRunSchema);
  const sourcePage = paginationSchema(sourceDetailSchema);

  return {
    createMemo: (
      text: string,
      capturedAt: string,
      timezone: string,
      clientRequestId: string,
      opts: { process?: boolean; privacy?: "default" | "local_only"; attachmentTokens?: string[] } = {},
    ): Promise<MemoReceipt> =>
      request("POST", "/memos", memoReceiptSchema, {
        client_request_id: clientRequestId,
        text,
        ...(opts.attachmentTokens && opts.attachmentTokens.length > 0 ? { attachment_tokens: opts.attachmentTokens } : {}),
        captured_at: capturedAt,
        timezone,
        process: opts.process ?? true,
        privacy: opts.privacy ?? "default",
      }),
    /** Stage one image; the returned token goes into createMemo. Do not set content-type by hand. */
    uploadAttachment: (file: Blob, name: string): Promise<AttachmentUploadReceipt> => {
      const form = new FormData();
      form.append("file", file, name);
      return request("POST", "/attachments", attachmentUploadReceiptSchema, form, undefined, 120000);
    },
    ocrRuns: (attachmentId: string): Promise<OcrRun[]> =>
      request("GET", `/attachments/${attachmentId}/ocr-runs`, ocrRunPage).then((p) => p.items),
    correctOcr: (attachmentId: string, body: { text: string; expected_run_id: string | null; reprocess?: boolean }): Promise<OcrCorrectionResult> =>
      request("POST", `/attachments/${attachmentId}/ocr-corrections`, ocrCorrectionResultSchema, { reprocess: true, ...body }),
    sources: (entityType: "task" | "appointment" | "note", entityId: string): Promise<SourceDetail[]> =>
      request("GET", `/sources?entity_type=${entityType}&entity_id=${encodeURIComponent(entityId)}`, sourcePage).then((p) => p.items),
    /** Absolute URL of an attachment's content_path (relative to the API origin). */
    attachmentUrl: (contentPath: string): string => `${base}${contentPath.startsWith("/") ? "" : "/"}${contentPath}`,
    listMemos: (limit = 10): Promise<MemoDetail[]> =>
      request("GET", `/memos?limit=${limit}`, memoPage).then((p) => p.items),
    getMemo: (id: string): Promise<MemoDetail> => request("GET", `/memos/${id}`, memoDetailSchema),
    reprocessMemo: (id: string): Promise<Job> => request("POST", `/memos/${id}/reprocess`, jobSchema, {}),
    answerClarification: (id: string, expectedVersion: number, answer: ClarificationAnswer["answer"]): Promise<ClarificationResult> =>
      request("POST", `/clarifications/${id}/answer`, clarificationResultSchema, { expected_version: expectedVersion, answer }),
    undoActionGroup: (id: string): Promise<UndoResult> => request("POST", `/action-groups/${id}/undo`, undoResultSchema, {}),

    /* ---- AI settings (the key is write-only: sent here, never read back) ---- */
    listConnections: (): Promise<AiConnection[]> =>
      request("GET", "/ai/connections", aiConnectionListSchema).then((p) => p.items),
    createConnection: (input: AiConnectionCreate): Promise<AiConnection> =>
      request("POST", "/ai/connections", aiConnectionSchema, input, key()),
    patchConnection: (id: string, input: AiConnectionPatch): Promise<AiConnection> =>
      request("PATCH", `/ai/connections/${id}`, aiConnectionSchema, input),
    testConnection: (id: string, kind: "metadata" | "text" | "image", modelId?: string): Promise<AiConnectionTestResult> =>
      request("POST", `/ai/connections/${id}/test`, aiConnectionTestResultSchema, { kind, ...(modelId ? { model_id: modelId } : {}) }, undefined, 300000),
    listModels: (id: string): Promise<AiModelList> =>
      request("GET", `/ai/connections/${id}/models`, aiModelListSchema, undefined, undefined, 60000),
    listRoles: (): Promise<AiRoleBinding[]> =>
      request("GET", "/ai/roles", aiRoleListSchema).then((p) => p.items),
    putRoles: (roles: Array<Partial<AiRoleBindingInput> & Pick<AiRoleBindingInput, "role" | "connection_id" | "model_id">>): Promise<AiRoleBinding[]> =>
      request("PUT", "/ai/roles", aiRoleListSchema, { roles }).then((p) => p.items),
    listTasks: (): Promise<Task[]> => request("GET", "/tasks?limit=100", taskPage).then((p) => p.items),
    createTask: (input: { title: string; due_date?: string; source?: { memo_revision_id: string; quote?: string } }): Promise<Task> =>
      request("POST", "/tasks", taskSchema, input, key()),
    completeTask: (id: string, v: number): Promise<Task> =>
      request("POST", `/tasks/${id}/complete`, taskSchema, { expected_version: v }),
    reopenTask: (id: string, v: number): Promise<Task> =>
      request("POST", `/tasks/${id}/reopen`, taskSchema, { expected_version: v }),
    listNotes: (): Promise<Note[]> => request("GET", "/notes?limit=100", noteGroup).then((p) => p.items),
    createNote: (title: string, body: string): Promise<Note> =>
      request("POST", "/notes", noteSchema, { title, body }, key()),
    listAppointments: (): Promise<Appointment[]> =>
      request("GET", "/appointments?limit=100", apptPage).then((p) => p.items),
    createAppointment: (title: string, startsAt: string): Promise<Appointment> =>
      request("POST", "/appointments", appointmentSchema, { title, starts_at: startsAt }, key()),
    listNotifications: (unreadOnly: boolean): Promise<Notification[]> =>
      request("GET", `/notifications?limit=50${unreadOnly ? "&unread=true" : ""}`, notifPage).then((p) => p.items),
    ackNotification: (id: string): Promise<Notification> =>
      request("POST", `/notifications/${id}/ack`, notificationSchema, {}),
    snoozeNotification: (id: string, minutes: number): Promise<Notification> =>
      request("POST", `/notifications/${id}/snooze`, notificationSchema, { minutes }),
  };
}

export type Api = ReturnType<typeof createApi>;
