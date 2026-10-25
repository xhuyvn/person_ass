import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { attachmentUploadReceiptSchema } from "@personalass/contracts";
import { DomainError, parse, type Ctx } from "../domain/core.js";
import { readOriginalForServing, stageUpload, type AppPaths, type AttachmentLimits } from "../storage/attachments.js";
import type { OpenApiOp, V1Deps } from "./v1.js";

const idParams = z.object({ id: z.uuid() });

export type AttachmentDeps = { paths: AppPaths; limits: AttachmentLimits };

/** M3 routes: staged image upload and original-image serving (docs/03 §4). */
export function registerAttachmentRoutes(
  app: FastifyInstance,
  deps: V1Deps & { attachments: AttachmentDeps },
  ops: OpenApiOp[],
): void {
  const { paths, limits } = deps.attachments;
  const ctxOf = (req: FastifyRequest): Ctx => ({
    db: deps.db,
    clock: deps.clock,
    correlationId: (req as FastifyRequest & { correlationId?: string }).correlationId,
  });

  ops.push({
    method: "POST",
    path: "/api/v1/attachments",
    summary: "Tải ảnh lên (multipart, trường `file`), nhận attachment_token tạm thời; chưa tạo job",
    response: attachmentUploadReceiptSchema,
    status: 201,
  });
  app.post("/api/v1/attachments", async (req, reply) => {
    let part;
    try {
      part = await req.file();
    } catch (err) {
      throw uploadError(err);
    }
    if (!part || part.fieldname !== "file") {
      throw new DomainError("BAD_REQUEST", "Thiếu tệp ảnh (trường `file`).", { file: "Thiếu tệp ảnh." });
    }
    let data: Buffer;
    try {
      data = await part.toBuffer();
    } catch (err) {
      throw uploadError(err);
    }
    if (part.file.truncated) {
      throw new DomainError("PAYLOAD_TOO_LARGE", "Ảnh quá lớn.", { file: "Ảnh vượt giới hạn dung lượng." });
    }
    const receipt = await stageUpload(ctxOf(req), paths, limits, {
      data,
      declaredMime: part.mimetype,
      originalName: part.filename || null,
    });
    return reply.code(201).send(receipt);
  });

  ops.push({
    method: "GET",
    path: "/api/v1/attachments/:id/content",
    summary: "Ảnh gốc của ảnh đã gắn vào memo (nhị phân, không phải JSON)",
    response: z.any(),
    status: 200,
  });
  app.get("/api/v1/attachments/:id/content", async (req, reply) => {
    const id = parse(idParams, req.params).id;
    const file = readOriginalForServing(ctxOf(req), paths, id);
    return reply
      .header("Content-Type", file.mime)
      .header("X-Content-Type-Options", "nosniff")
      .header("Content-Security-Policy", "default-src 'none'; sandbox")
      .header("Content-Disposition", `inline; filename="${id}.${file.ext}"`)
      .header("Cache-Control", "private, max-age=31536000, immutable")
      .send(file.data);
  });
}

function uploadError(err: unknown): Error {
  const code = (err as { code?: string }).code;
  if (code === "FST_REQ_FILE_TOO_LARGE" || code === "FST_FILES_LIMIT") {
    return new DomainError("PAYLOAD_TOO_LARGE", "Ảnh quá lớn.", { file: "Ảnh vượt giới hạn dung lượng." });
  }
  if (err instanceof DomainError) return err;
  return new DomainError("BAD_REQUEST", "Yêu cầu tải ảnh không hợp lệ (cần multipart/form-data với trường `file`).");
}
