import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  appointmentCreateSchema,
  appointmentPatchSchema,
  appointmentSchema,
  listQuerySchema,
  memoCreateSchema,
  memoDetailSchema,
  memoReceiptSchema,
  noteCreateSchema,
  notePatchSchema,
  noteSchema,
  notificationSchema,
  paginationSchema,
  reminderRuleCreateSchema,
  reminderRuleSchema,
  snoozeSchema,
  taskCreateSchema,
  taskPatchSchema,
  taskSchema,
  versionedActionSchema,
} from "@personalass/contracts";
import type { Db } from "../db/open.js";
import { transaction } from "../db/open.js";
import { idempotent, parse, type Clock, type Ctx } from "../domain/core.js";
import * as entities from "../domain/entities.js";
import { createMemo, getMemo, listMemos } from "../domain/memos.js";
import {
  ackNotification,
  listNotifications,
  snoozeNotification,
} from "../domain/notifications.js";
import { createReminderRule, getReminderRule, listReminderRules } from "../domain/reminders.js";
import type { AiDeps } from "../domain/ai-config.js";
import { registerAiRoutes } from "./v1-ai.js";
import { registerAttachmentRoutes, type AttachmentDeps } from "./v1-attachments.js";

export type V1Deps = {
  db: Db;
  clock: Clock;
  ai: AiDeps;
  /** Image storage paths and limits (M3). */
  attachments: AttachmentDeps;
  /** Called after a job was queued so the worker picks it up without waiting for its poll. */
  onJobQueued?: () => void;
};

export type OpenApiOp = {
  method: string;
  path: string;
  summary: string;
  request?: z.ZodType;
  response: z.ZodType;
  status: number;
};

const idParams = z.object({ id: z.uuid() });
const archiveBody = versionedActionSchema.extend({ confirm: z.literal(true) });

/** OpenAPI 3.1 document derived from the same Zod schemas the routes validate with. */
export function buildOpenApi(ops: OpenApiOp[], version: string): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const op of ops) {
    const p = op.path.replace(/:(\w+)/g, "{$1}");
    paths[p] ??= {};
    (paths[p] as Record<string, unknown>)[op.method.toLowerCase()] = {
      summary: op.summary,
      ...(op.request
        ? { requestBody: { required: true, content: { "application/json": { schema: z.toJSONSchema(op.request, { io: "input" }) } } } }
        : {}),
      responses: {
        [String(op.status)]: {
          description: "OK",
          content: { "application/json": { schema: z.toJSONSchema(op.response) } },
        },
        default: { description: "Error envelope (docs/03 §4)" },
      },
    };
  }
  return { openapi: "3.1.0", info: { title: "personalass API", version }, paths };
}

export async function registerV1Routes(app: FastifyInstance, deps: V1Deps): Promise<OpenApiOp[]> {
  const ops: OpenApiOp[] = [];
  const ctxOf = (req: FastifyRequest): Ctx => ({
    db: deps.db,
    clock: deps.clock,
    correlationId: (req as FastifyRequest & { correlationId?: string }).correlationId,
  });
  const idemKey = (req: FastifyRequest): string | undefined => {
    const h = req.headers["idempotency-key"];
    return Array.isArray(h) ? h[0] : h;
  };
  const tx = <T>(ctx: Ctx, fn: () => T): T => transaction(ctx.db, fn);
  const idOf = (req: FastifyRequest): string => parse(idParams, req.params).id;

  const page = <T extends z.ZodType>(item: T) => paginationSchema(item);

  /* ---- memos ---- */
  ops.push({ method: "POST", path: "/api/v1/memos", summary: "Lưu memo bền vững, tạo job xử lý AI (202-style receipt)", request: memoCreateSchema, response: memoReceiptSchema, status: 201 });
  app.post("/api/v1/memos", async (req, reply) => {
    const ctx = ctxOf(req);
    const input = parse(memoCreateSchema, req.body);
    const out = idempotent(ctx, idemKey(req), "POST /memos", input, () => {
      const r = createMemo(ctx, input, { maxImages: deps.attachments.limits.maxImages });
      return { status: r.created ? 201 : 200, body: r.receipt };
    });
    if (out.body.job_id) deps.onJobQueued?.();
    return reply.code(out.status).send(out.body);
  });
  ops.push({ method: "GET", path: "/api/v1/memos", summary: "Danh sách memo", response: page(memoDetailSchema), status: 200 });
  app.get("/api/v1/memos", async (req) => listMemos(ctxOf(req), parse(listQuerySchema, req.query)));
  ops.push({ method: "GET", path: "/api/v1/memos/:id", summary: "Chi tiết memo + nguồn", response: memoDetailSchema, status: 200 });
  app.get("/api/v1/memos/:id", async (req) => getMemo(ctxOf(req), idOf(req)));

  /* ---- tasks ---- */
  ops.push({ method: "POST", path: "/api/v1/tasks", summary: "Tạo task", request: taskCreateSchema, response: taskSchema, status: 201 });
  app.post("/api/v1/tasks", async (req, reply) => {
    const ctx = ctxOf(req);
    const input = parse(taskCreateSchema, req.body);
    const out = idempotent(ctx, idemKey(req), "POST /tasks", input, () => ({
      status: 201,
      body: entities.createTask(ctx, input),
    }));
    return reply.code(out.status).send(out.body);
  });
  ops.push({ method: "GET", path: "/api/v1/tasks", summary: "Danh sách task", response: page(taskSchema), status: 200 });
  app.get("/api/v1/tasks", async (req) => entities.listTasks(ctxOf(req), parse(listQuerySchema, req.query)));
  ops.push({ method: "GET", path: "/api/v1/tasks/:id", summary: "Chi tiết task", response: taskSchema, status: 200 });
  app.get("/api/v1/tasks/:id", async (req) => entities.getTask(ctxOf(req), idOf(req)));
  ops.push({ method: "PATCH", path: "/api/v1/tasks/:id", summary: "Sửa task (expected_version bắt buộc)", request: taskPatchSchema, response: taskSchema, status: 200 });
  app.patch("/api/v1/tasks/:id", async (req) => {
    const ctx = ctxOf(req);
    const id = idOf(req);
    const input = parse(taskPatchSchema, req.body);
    return tx(ctx, () => entities.patchTask(ctx, id, input));
  });
  ops.push({ method: "POST", path: "/api/v1/tasks/:id/complete", summary: "Hoàn thành task", request: versionedActionSchema, response: taskSchema, status: 200 });
  app.post("/api/v1/tasks/:id/complete", async (req) => {
    const ctx = ctxOf(req);
    const id = idOf(req);
    const input = parse(versionedActionSchema, req.body);
    return tx(ctx, () => entities.setTaskDone(ctx, id, input.expected_version, true));
  });
  ops.push({ method: "POST", path: "/api/v1/tasks/:id/reopen", summary: "Mở lại task", request: versionedActionSchema, response: taskSchema, status: 200 });
  app.post("/api/v1/tasks/:id/reopen", async (req) => {
    const ctx = ctxOf(req);
    const id = idOf(req);
    const input = parse(versionedActionSchema, req.body);
    return tx(ctx, () => entities.setTaskDone(ctx, id, input.expected_version, false));
  });

  /* ---- notes ---- */
  ops.push({ method: "POST", path: "/api/v1/notes", summary: "Tạo ghi chú", request: noteCreateSchema, response: noteSchema, status: 201 });
  app.post("/api/v1/notes", async (req, reply) => {
    const ctx = ctxOf(req);
    const input = parse(noteCreateSchema, req.body);
    const out = idempotent(ctx, idemKey(req), "POST /notes", input, () => ({
      status: 201,
      body: entities.createNote(ctx, input),
    }));
    return reply.code(out.status).send(out.body);
  });
  ops.push({ method: "GET", path: "/api/v1/notes", summary: "Danh sách ghi chú", response: page(noteSchema), status: 200 });
  app.get("/api/v1/notes", async (req) => entities.listNotes(ctxOf(req), parse(listQuerySchema, req.query)));
  ops.push({ method: "GET", path: "/api/v1/notes/:id", summary: "Chi tiết ghi chú", response: noteSchema, status: 200 });
  app.get("/api/v1/notes/:id", async (req) => entities.getNote(ctxOf(req), idOf(req)));
  ops.push({ method: "PATCH", path: "/api/v1/notes/:id", summary: "Sửa ghi chú", request: notePatchSchema, response: noteSchema, status: 200 });
  app.patch("/api/v1/notes/:id", async (req) => {
    const ctx = ctxOf(req);
    const id = idOf(req);
    const input = parse(notePatchSchema, req.body);
    return tx(ctx, () => entities.patchNote(ctx, id, input));
  });

  /* ---- appointments ---- */
  ops.push({ method: "POST", path: "/api/v1/appointments", summary: "Tạo lịch hẹn", request: appointmentCreateSchema, response: appointmentSchema, status: 201 });
  app.post("/api/v1/appointments", async (req, reply) => {
    const ctx = ctxOf(req);
    const input = parse(appointmentCreateSchema, req.body);
    const out = idempotent(ctx, idemKey(req), "POST /appointments", input, () => ({
      status: 201,
      body: entities.createAppointment(ctx, input),
    }));
    return reply.code(out.status).send(out.body);
  });
  ops.push({ method: "GET", path: "/api/v1/appointments", summary: "Danh sách lịch hẹn", response: page(appointmentSchema), status: 200 });
  app.get("/api/v1/appointments", async (req) => entities.listAppointments(ctxOf(req), parse(listQuerySchema, req.query)));
  ops.push({ method: "GET", path: "/api/v1/appointments/:id", summary: "Chi tiết lịch hẹn", response: appointmentSchema, status: 200 });
  app.get("/api/v1/appointments/:id", async (req) => entities.getAppointment(ctxOf(req), idOf(req)));
  ops.push({ method: "PATCH", path: "/api/v1/appointments/:id", summary: "Sửa/dời lịch hẹn", request: appointmentPatchSchema, response: appointmentSchema, status: 200 });
  app.patch("/api/v1/appointments/:id", async (req) => {
    const ctx = ctxOf(req);
    const id = idOf(req);
    const input = parse(appointmentPatchSchema, req.body);
    return tx(ctx, () => entities.patchAppointment(ctx, id, input));
  });

  /* ---- archive ---- */
  const archiveResp = z.object({ id: z.uuid(), version: z.number().int() });
  ops.push({ method: "POST", path: "/api/v1/entities/:type/:id/archive", summary: "Lưu trữ (cần confirm), hủy nhắc liên quan", request: archiveBody, response: archiveResp, status: 200 });
  app.post("/api/v1/entities/:type/:id/archive", async (req) => {
    const ctx = ctxOf(req);
    const { type, id } = parse(z.object({ type: z.string(), id: z.uuid() }), req.params);
    const input = parse(archiveBody, req.body);
    return tx(ctx, () => entities.archiveEntity(ctx, type, id, input.expected_version));
  });

  /* ---- reminder rules ---- */
  ops.push({ method: "POST", path: "/api/v1/reminder-rules", summary: "Thêm quy tắc nhắc cho task/lịch hẹn", request: reminderRuleCreateSchema, response: reminderRuleSchema, status: 201 });
  app.post("/api/v1/reminder-rules", async (req, reply) => {
    const ctx = ctxOf(req);
    const input = parse(reminderRuleCreateSchema, req.body);
    const out = idempotent(ctx, idemKey(req), "POST /reminder-rules", input, () => ({
      status: 201,
      body: createReminderRule(ctx, input),
    }));
    return reply.code(out.status).send(out.body);
  });
  ops.push({ method: "GET", path: "/api/v1/reminder-rules", summary: "Quy tắc nhắc (lọc entity_id)", response: z.object({ items: z.array(reminderRuleSchema) }), status: 200 });
  app.get("/api/v1/reminder-rules", async (req) => {
    const q = parse(z.object({ entity_id: z.uuid().optional() }), req.query);
    return { items: listReminderRules(ctxOf(req), q.entity_id) };
  });
  ops.push({ method: "GET", path: "/api/v1/reminder-rules/:id", summary: "Chi tiết quy tắc nhắc", response: reminderRuleSchema, status: 200 });
  app.get("/api/v1/reminder-rules/:id", async (req) => getReminderRule(ctxOf(req), idOf(req)));

  /* ---- notifications ---- */
  ops.push({ method: "GET", path: "/api/v1/notifications", summary: "Thông báo in-app bền vững (?unread=true)", response: page(notificationSchema), status: 200 });
  app.get("/api/v1/notifications", async (req) => listNotifications(ctxOf(req), parse(listQuerySchema, req.query)));
  ops.push({ method: "POST", path: "/api/v1/notifications/:id/ack", summary: "Xác nhận đã đọc (idempotent)", response: notificationSchema, status: 200 });
  app.post("/api/v1/notifications/:id/ack", async (req) => ackNotification(ctxOf(req), idOf(req)));
  ops.push({ method: "POST", path: "/api/v1/notifications/:id/snooze", summary: "Hoãn nhắc (không dời deadline)", request: snoozeSchema, response: notificationSchema, status: 200 });
  app.post("/api/v1/notifications/:id/snooze", async (req) => {
    const input = parse(snoozeSchema, req.body);
    return snoozeNotification(ctxOf(req), idOf(req), input.minutes);
  });

  registerAiRoutes(app, deps, ops);
  registerAttachmentRoutes(app, deps, ops);
  return ops;
}
