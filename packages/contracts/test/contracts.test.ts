import { describe, expect, it } from "vitest";
import {
  ApiErrorCode,
  apiErrorStatusByCode,
  apiErrorSchema,
  appointmentDtoSchema,
  healthLiveSchema,
  healthReadySchema,
  paginationSchema,
  taskDtoSchema,
} from "@personalass/contracts";
import { toErrorEnvelope } from "@personalass/contracts/errors";

const UUID = "00000000-0000-4000-8000-000000000001";

const validReadyPayload = {
  status: "ok" as const,
  checks: {
    database: { ok: true, migrations_applied: 2 },
    data_dir: { ok: true },
  },
  time: "2026-10-22T08:00:00.000Z",
};

describe("apiErrorSchema", () => {
  it("parses a full valid error envelope", () => {
    const parsed = apiErrorSchema.parse({
      error: {
        code: "NOT_FOUND",
        message: "Route not found",
        field_errors: { title: "Required" },
        retryable: false,
        correlation_id: "corr-1",
      },
    });

    expect(parsed.error.code).toBe("NOT_FOUND");
    expect(parsed.error.message).toBe("Route not found");
    expect(parsed.error.field_errors).toEqual({ title: "Required" });
    expect(parsed.error.retryable).toBe(false);
    expect(parsed.error.correlation_id).toBe("corr-1");
  });

  it("rejects an unknown error code", () => {
    const result = apiErrorSchema.safeParse({
      error: {
        code: "TEAPOT",
        message: "Short and stout",
        retryable: false,
        correlation_id: "corr-1",
      },
    });

    expect(result.success).toBe(false);
  });

  it("rejects a missing retryable flag", () => {
    const result = apiErrorSchema.safeParse({
      error: {
        code: "NOT_FOUND",
        message: "Route not found",
        correlation_id: "corr-1",
      },
    });

    expect(result.success).toBe(false);
  });

  it("rejects an empty correlation_id", () => {
    const result = apiErrorSchema.safeParse({
      error: {
        code: "NOT_FOUND",
        message: "Route not found",
        retryable: false,
        correlation_id: "",
      },
    });

    expect(result.success).toBe(false);
  });
});

describe("apiErrorStatusByCode", () => {
  it("maps every ApiErrorCode to its HTTP status (docs/03 §4)", () => {
    const expected: Record<string, number> = {
      BAD_REQUEST: 400,
      UNAUTHORIZED: 401,
      FORBIDDEN: 403,
      NOT_FOUND: 404,
      CONFLICT: 409,
      PAYLOAD_TOO_LARGE: 413,
      UNPROCESSABLE_ENTITY: 422,
      RATE_LIMITED: 429,
      INTERNAL_ERROR: 500,
    };

    expect(ApiErrorCode.options).toEqual(Object.keys(expected));
    for (const [code, status] of Object.entries(expected)) {
      expect(apiErrorStatusByCode[code as keyof typeof apiErrorStatusByCode]).toBe(
        status,
      );
    }
  });

  it("maps every declared code to a documented status code", () => {
    const documented = new Set([
      400, 401, 403, 404, 409, 413, 422, 429, 500,
    ]);

    for (const code of ApiErrorCode.options) {
      const status = apiErrorStatusByCode[code];
      expect(status).toBeTypeOf("number");
      expect(documented.has(status)).toBe(true);
    }
  });

  it("never maps two different codes to the same status", () => {
    const statuses = ApiErrorCode.options.map(
      (code) => apiErrorStatusByCode[code],
    );

    expect(new Set(statuses).size).toBe(statuses.length);
  });
});

describe("toErrorEnvelope", () => {
  it("returns code, message, retryable and correlation_id", () => {
    const envelope = toErrorEnvelope("NOT_FOUND", "Route not found", {
      correlationId: "corr-1",
    });

    expect(envelope.error.code).toBe("NOT_FOUND");
    expect(envelope.error.message).toBe("Route not found");
    expect(envelope.error.retryable).toBe(false);
    expect(envelope.error.correlation_id).toBe("corr-1");
  });

  it("includes field_errors only when provided", () => {
    const envelope = toErrorEnvelope("BAD_REQUEST", "Invalid", {
      correlationId: "corr-2",
      fieldErrors: { title: "Required" },
    });

    expect(envelope.error.field_errors).toEqual({ title: "Required" });
  });

  it("never returns an empty field_errors key", () => {
    const withoutFieldErrors = toErrorEnvelope("BAD_REQUEST", "Invalid", {
      correlationId: "corr-3",
    });
    expect("field_errors" in withoutFieldErrors.error).toBe(false);

    const withEmptyFieldErrors = toErrorEnvelope("BAD_REQUEST", "Invalid", {
      correlationId: "corr-4",
      fieldErrors: {},
    });
    expect("field_errors" in withEmptyFieldErrors.error).toBe(false);
  });
});

describe("healthReadySchema", () => {
  it("accepts status ok with the full checks structure", () => {
    const parsed = healthReadySchema.parse(validReadyPayload);

    expect(parsed.status).toBe("ok");
    expect(parsed.checks.database.ok).toBe(true);
    expect(parsed.checks.database.migrations_applied).toBe(2);
    expect(parsed.checks.data_dir.ok).toBe(true);
  });

  it("accepts status degraded with the full checks structure", () => {
    const parsed = healthReadySchema.parse({
      status: "degraded",
      checks: {
        database: {
          ok: false,
          migrations_applied: 1,
          detail: "pending migrations: 0002_core_indexes.sql",
        },
        data_dir: { ok: true },
      },
      time: "2026-10-22T08:00:00.000Z",
    });

    expect(parsed.status).toBe("degraded");
    expect(parsed.checks.database.ok).toBe(false);
  });

  it("rejects an unknown status", () => {
    const result = healthReadySchema.safeParse({
      ...validReadyPayload,
      status: "unknown",
    });

    expect(result.success).toBe(false);
  });

  it("rejects a payload without checks.data_dir", () => {
    const result = healthReadySchema.safeParse({
      status: "ok",
      checks: { database: { ok: true, migrations_applied: 2 } },
      time: "2026-10-22T08:00:00.000Z",
    });

    expect(result.success).toBe(false);
  });
});

describe("healthLiveSchema", () => {
  it("accepts a valid live payload", () => {
    const parsed = healthLiveSchema.parse({
      status: "ok",
      service: "personalass-server",
      version: "0.0.0",
      uptime_s: 1.5,
      time: "2026-10-22T08:00:00.000Z",
    });

    expect(parsed.status).toBe("ok");
    expect(parsed.service).toBe("personalass-server");
  });

  it("rejects status degraded (live must be ok)", () => {
    const result = healthLiveSchema.safeParse({
      status: "degraded",
      service: "personalass-server",
      version: "0.0.0",
      uptime_s: 1.5,
      time: "2026-10-22T08:00:00.000Z",
    });

    expect(result.success).toBe(false);
  });
});

describe("paginationSchema", () => {
  it("returns items and next_cursor", () => {
    const schema = paginationSchema(taskDtoSchema);
    const task = {
      id: UUID,
      version: 1,
      created_at: "2026-10-22T08:00:00.000Z",
      updated_at: "2026-10-22T08:00:00.000Z",
      owner_id: "owner-1",
      title: "Mua nước giặt",
      status: "open",
      priority: 0,
    };

    const parsed = schema.parse({ items: [task], next_cursor: "cursor-1" });
    expect(parsed.items).toHaveLength(1);
    expect(parsed.next_cursor).toBe("cursor-1");
  });

  it("allows a null next_cursor", () => {
    const schema = paginationSchema(taskDtoSchema);
    const parsed = schema.parse({ items: [], next_cursor: null });

    expect(parsed.items).toEqual([]);
    expect(parsed.next_cursor).toBeNull();
  });
});

describe("taskDtoSchema", () => {
  const validTask = {
    id: UUID,
    version: 1,
    created_at: "2026-10-22T08:00:00.000Z",
    updated_at: "2026-10-22T08:00:00.000Z",
    owner_id: "owner-1",
    title: "Mua nước giặt",
    status: "open",
    priority: 2,
  };

  it("accepts a valid task", () => {
    const parsed = taskDtoSchema.parse(validTask);

    expect(parsed.title).toBe("Mua nước giặt");
    expect(parsed.priority).toBe(2);
  });

  it("rejects status deleted", () => {
    const result = taskDtoSchema.safeParse({ ...validTask, status: "deleted" });

    expect(result.success).toBe(false);
  });

  it("rejects a priority of -1", () => {
    const result = taskDtoSchema.safeParse({ ...validTask, priority: -1 });

    expect(result.success).toBe(false);
  });

  it("rejects a non-integer version", () => {
    const result = taskDtoSchema.safeParse({ ...validTask, version: 1.5 });

    expect(result.success).toBe(false);
  });
});

describe("appointmentDtoSchema", () => {
  it("accepts a valid timed appointment", () => {
    const parsed = appointmentDtoSchema.parse({
      id: UUID,
      version: 1,
      created_at: "2026-10-22T08:00:00.000Z",
      updated_at: "2026-10-22T08:00:00.000Z",
      owner_id: "owner-1",
      title: "Họp với Minh",
      starts_at: "2026-10-22T09:00:00+07:00",
      timezone: "Asia/Ho_Chi_Minh",
      all_day: false,
      status: "scheduled",
    });

    expect(parsed.starts_at).toBe("2026-10-22T09:00:00+07:00");
    expect(parsed.all_day).toBe(false);
  });

  it("rejects status unknown", () => {
    const result = appointmentDtoSchema.safeParse({
      id: UUID,
      version: 1,
      created_at: "2026-10-22T08:00:00.000Z",
      updated_at: "2026-10-22T08:00:00.000Z",
      owner_id: "owner-1",
      title: "Họp với Minh",
      starts_at: "2026-10-22T09:00:00+07:00",
      timezone: "Asia/Ho_Chi_Minh",
      all_day: false,
      status: "unknown",
    });

    expect(result.success).toBe(false);
  });
});
