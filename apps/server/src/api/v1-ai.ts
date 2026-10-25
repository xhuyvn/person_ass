import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  aiConnectionCreateSchema,
  aiConnectionPatchSchema,
  aiConnectionSchema,
  aiConnectionTestResultSchema,
  aiConnectionTestSchema,
  aiModelListSchema,
  aiRoleBindingSchema,
  aiRolesPutSchema,
  auditEventSchema,
  clarificationAnswerSchema,
  clarificationResultSchema,
  clarificationSchema,
  jobSchema,
  paginationSchema,
  undoResultSchema,
} from "@personalass/contracts";
import { transaction } from "../db/open.js";
import * as aiConfig from "../domain/ai-config.js";
import type { AiDeps } from "../domain/ai-config.js";
import { OWNER_ID, decodeCursor, idempotent, pageRows, parse, type Ctx, type Row } from "../domain/core.js";
import { answerClarification, listOpenClarifications, undoActionGroup } from "../domain/proposals.js";
import { getJob, reprocessMemo } from "../jobs/worker.js";
import type { OpenApiOp, V1Deps } from "./v1.js";

const idParams = z.object({ id: z.uuid() });

/** M2 routes: AI connections/roles, jobs, clarifications, undo, audit (docs/03 §4). */
export function registerAiRoutes(app: FastifyInstance, deps: V1Deps & { ai: AiDeps }, ops: OpenApiOp[]): void {
  const ctxOf = (req: FastifyRequest): Ctx => ({
    db: deps.db,
    clock: deps.clock,
    correlationId: (req as FastifyRequest & { correlationId?: string }).correlationId,
  });
  const idOf = (req: FastifyRequest): string => parse(idParams, req.params).id;
  const idemKey = (req: FastifyRequest): string | undefined => {
    const h = req.headers["idempotency-key"];
    return Array.isArray(h) ? h[0] : h;
  };
  const tx = <T>(ctx: Ctx, fn: () => T): T => transaction(ctx.db, fn);
  const wake = () => deps.onJobQueued?.();

  /* ---- connections ---- */
  ops.push({ method: "GET", path: "/api/v1/ai/connections", summary: "Kết nối AI (không bao giờ trả key)", response: z.object({ items: z.array(aiConnectionSchema) }), status: 200 });
  app.get("/api/v1/ai/connections", async (req) => ({ items: aiConfig.listConnections(ctxOf(req)) }));

  ops.push({ method: "POST", path: "/api/v1/ai/connections", summary: "Thêm kết nối AI (key chỉ nhận khi ghi)", request: aiConnectionCreateSchema, response: aiConnectionSchema, status: 201 });
  app.post("/api/v1/ai/connections", async (req, reply) => {
    const ctx = ctxOf(req);
    const input = parse(aiConnectionCreateSchema, req.body);
    // The idempotency record stores the response only, never the key.
    const out = idempotent(ctx, idemKey(req), "POST /ai/connections", { ...input, api_key: input.api_key ? "[set]" : null }, () => ({
      status: 201,
      body: aiConfig.createConnection(ctx, deps.ai, input),
    }));
    wake();
    return reply.code(out.status).send(out.body);
  });

  ops.push({ method: "GET", path: "/api/v1/ai/connections/:id", summary: "Chi tiết kết nối AI", response: aiConnectionSchema, status: 200 });
  app.get("/api/v1/ai/connections/:id", async (req) => aiConfig.getConnection(ctxOf(req), idOf(req)));

  ops.push({ method: "PATCH", path: "/api/v1/ai/connections/:id", summary: "Sửa kết nối AI (expected_version)", request: aiConnectionPatchSchema, response: aiConnectionSchema, status: 200 });
  app.patch("/api/v1/ai/connections/:id", async (req) => {
    const ctx = ctxOf(req);
    const id = idOf(req);
    const input = parse(aiConnectionPatchSchema, req.body);
    const out = tx(ctx, () => aiConfig.patchConnection(ctx, deps.ai, id, input));
    wake();
    return out;
  });

  ops.push({ method: "POST", path: "/api/v1/ai/connections/:id/test", summary: "Test metadata/text, không lưu gì", request: aiConnectionTestSchema, response: aiConnectionTestResultSchema, status: 200 });
  app.post("/api/v1/ai/connections/:id/test", async (req) => {
    const input = parse(aiConnectionTestSchema, req.body);
    return aiConfig.testConnection(ctxOf(req), deps.ai, idOf(req), input);
  });

  ops.push({ method: "GET", path: "/api/v1/ai/connections/:id/models", summary: "Danh sách model (cho phép nhập tay khi lỗi)", response: aiModelListSchema, status: 200 });
  app.get("/api/v1/ai/connections/:id/models", async (req) => aiConfig.listModels(ctxOf(req), deps.ai, idOf(req)));

  /* ---- roles ---- */
  ops.push({ method: "GET", path: "/api/v1/ai/roles", summary: "Gán kết nối/model cho information, ocr, assistant", response: z.object({ items: z.array(aiRoleBindingSchema) }), status: 200 });
  app.get("/api/v1/ai/roles", async (req) => ({ items: aiConfig.listRoles(ctxOf(req)) }));

  ops.push({ method: "PUT", path: "/api/v1/ai/roles", summary: "Đặt role + fallback", request: aiRolesPutSchema, response: z.object({ items: z.array(aiRoleBindingSchema) }), status: 200 });
  app.put("/api/v1/ai/roles", async (req) => {
    const ctx = ctxOf(req);
    const input = parse(aiRolesPutSchema, req.body);
    const items = tx(ctx, () => aiConfig.putRoles(ctx, input));
    wake();
    return { items };
  });

  /* ---- jobs ---- */
  ops.push({ method: "GET", path: "/api/v1/jobs/:id", summary: "Trạng thái job (lỗi đã che secret)", response: jobSchema, status: 200 });
  app.get("/api/v1/jobs/:id", async (req) => getJob(ctxOf(req), idOf(req)));

  ops.push({ method: "POST", path: "/api/v1/memos/:id/reprocess", summary: "Xử lý lại memo bằng job mới (không tạo trùng)", response: jobSchema, status: 202 });
  app.post("/api/v1/memos/:id/reprocess", async (req, reply) => {
    const ctx = ctxOf(req);
    const job = tx(ctx, () => reprocessMemo(ctx, idOf(req)));
    wake();
    return reply.code(202).send(job);
  });

  /* ---- clarifications ---- */
  ops.push({ method: "GET", path: "/api/v1/clarifications", summary: "Câu hỏi làm rõ đang mở", response: z.object({ items: z.array(clarificationSchema) }), status: 200 });
  app.get("/api/v1/clarifications", async (req) => {
    const q = parse(z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) }), req.query);
    return { items: listOpenClarifications(ctxOf(req), q.limit) };
  });

  ops.push({ method: "POST", path: "/api/v1/clarifications/:id/answer", summary: "Trả lời làm rõ; revalidate rồi áp dụng", request: clarificationAnswerSchema, response: clarificationResultSchema, status: 200 });
  app.post("/api/v1/clarifications/:id/answer", async (req) => {
    const ctx = ctxOf(req);
    const id = idOf(req);
    const input = parse(clarificationAnswerSchema, req.body);
    return tx(ctx, () => answerClarification(ctx, id, input));
  });

  /* ---- undo ---- */
  ops.push({ method: "POST", path: "/api/v1/action-groups/:id/undo", summary: "Hoàn tác nhóm thay đổi; 409 kèm diff nếu đã sửa tay", response: undoResultSchema, status: 200 });
  app.post("/api/v1/action-groups/:id/undo", async (req) => {
    const ctx = ctxOf(req);
    const id = idOf(req);
    return tx(ctx, () => undoActionGroup(ctx, id));
  });

  /* ---- audit ---- */
  ops.push({ method: "GET", path: "/api/v1/audit-events", summary: "Audit theo entity hoặc action group", response: paginationSchema(auditEventSchema), status: 200 });
  app.get("/api/v1/audit-events", async (req) => {
    const q = parse(
      z.object({
        entity_id: z.string().max(100).optional(),
        action_group_id: z.uuid().optional(),
        cursor: z.string().max(200).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      }),
      req.query,
    );
    const ctx = ctxOf(req);
    const cursor = decodeCursor(q.cursor);
    const args: unknown[] = [OWNER_ID];
    let where = "owner_id = ?";
    if (q.entity_id) {
      where += " AND entity_id = ?";
      args.push(q.entity_id);
    }
    if (q.action_group_id) {
      where += " AND action_group_id = ?";
      args.push(q.action_group_id);
    }
    if (cursor) {
      where += " AND (created_at < ? OR (created_at = ? AND id < ?))";
      args.push(cursor.createdAt, cursor.createdAt, cursor.id);
    }
    args.push(q.limit + 1);
    const rows = ctx.db
      .prepare(`SELECT * FROM audit_events WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(...(args as never[])) as Row[];
    const { rows: kept, next } = pageRows(rows, q.limit);
    return {
      items: kept.map((r) => ({
        id: String(r.id),
        actor: r.actor as "user" | "ai" | "system",
        action: String(r.action),
        entity_type: (r.entity_type as string | null) ?? null,
        entity_id: (r.entity_id as string | null) ?? null,
        action_group_id: (r.action_group_id as string | null) ?? null,
        before: r.before_json ? JSON.parse(String(r.before_json)) : null,
        after: r.after_json ? JSON.parse(String(r.after_json)) : null,
        source: (r.source as string | null) ?? null,
        created_at: String(r.created_at),
      })),
      next_cursor: next,
    };
  });
}
