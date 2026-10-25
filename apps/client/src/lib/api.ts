import {
  apiErrorSchema,
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
  ): Promise<z.output<S>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(`${base}/api/v1${path}`, {
        method,
        headers: {
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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

  return {
    createMemo: (text: string, capturedAt: string, timezone: string, clientRequestId: string): Promise<MemoReceipt> =>
      request("POST", "/memos", memoReceiptSchema, {
        client_request_id: clientRequestId,
        text,
        captured_at: capturedAt,
        timezone,
        // The M1 screen creates tasks from a memo by hand and does not show
        // AI results yet; AI processing is switched on with the M2 UI.
        process: false,
      }),
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
