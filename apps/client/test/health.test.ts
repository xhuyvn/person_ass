import { describe, expect, it, vi } from "vitest";
import { checkHealth } from "../src/lib/health.js";

const BASE_URL = "http://127.0.0.1:4310";

const VALID_PAYLOAD = {
  status: "ok",
  checks: {
    database: { ok: true, migrations_applied: 2 },
    data_dir: { ok: true },
  },
  time: "2026-10-22T08:00:00.000Z",
};

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function expectError(result: Awaited<ReturnType<typeof checkHealth>>) {
  if (result.status !== "error") {
    throw new Error("expected an error result");
  }
  return result;
}

/** Vietnamese diacritics: every user facing message must contain at least one. */
const VIETNAMESE = /[àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ]/i;

const STACK_MARKERS = ["\n", "    at ", "node_modules", "Error:", "stack"];

describe("checkHealth", () => {
  it("returns the parsed payload on success", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, VALID_PAYLOAD),
    ) as unknown as typeof fetch;

    const result = await checkHealth({ baseUrl: BASE_URL, fetchImpl });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.data.checks.database.migrations_applied).toBe(2);
  });

  it("reports http_error without leaking the raw body", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(500, { error: "SECRET_INTERNAL_DETAIL" }),
    ) as unknown as typeof fetch;

    const result = expectError(
      await checkHealth({ baseUrl: BASE_URL, fetchImpl }),
    );

    expect(result.reason).toBe("http_error");
    expect(result.message).not.toContain("SECRET_INTERNAL_DETAIL");
    expect(result.message).toContain("500");
  });

  it("reports network when the request fails", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;

    const result = expectError(
      await checkHealth({ baseUrl: BASE_URL, fetchImpl }),
    );

    expect(result.reason).toBe("network");
  });

  it("reports timeout when the request never settles", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(
        () => new Promise<Response>(() => undefined),
      ) as unknown as typeof fetch;

      const pending = checkHealth({
        baseUrl: BASE_URL,
        timeoutMs: 50,
        fetchImpl,
      });

      await vi.advanceTimersByTimeAsync(100);
      const result = expectError(await pending);

      expect(result.reason).toBe("timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports invalid_payload for a payload that does not match the schema", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { ...VALID_PAYLOAD, status: "weird" }),
    ) as unknown as typeof fetch;

    const result = expectError(
      await checkHealth({ baseUrl: BASE_URL, fetchImpl }),
    );

    expect(result.reason).toBe("invalid_payload");
    expect(result.message).not.toContain("weird");
  });

  it("joins the base url and the path without a double slash", async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return jsonResponse(200, VALID_PAYLOAD);
    }) as unknown as typeof fetch;

    await checkHealth({ baseUrl: `${BASE_URL}/`, fetchImpl });

    expect(seen[0]).toBe(`${BASE_URL}/health/ready`);
    expect(seen[0]?.includes(BASE_URL)).toBe(true);
    expect(seen[0]).not.toContain("//health");
  });

  it("uses only safe, Vietnamese error messages", async () => {
    const messages: string[] = [];

    const httpError = expectError(
      await checkHealth({
        baseUrl: BASE_URL,
        fetchImpl: (async () => jsonResponse(500, {})) as unknown as typeof fetch,
      }),
    );
    messages.push(httpError.message);

    const networkError = expectError(
      await checkHealth({
        baseUrl: BASE_URL,
        fetchImpl: (async () => {
          throw new Error("boom");
        }) as unknown as typeof fetch,
      }),
    );
    messages.push(networkError.message);

    const invalidPayload = expectError(
      await checkHealth({
        baseUrl: BASE_URL,
        fetchImpl: (async () =>
          jsonResponse(200, { status: "weird" })) as unknown as typeof fetch,
      }),
    );
    messages.push(invalidPayload.message);

    for (const message of messages) {
      expect(message).toMatch(VIETNAMESE);
      for (const marker of STACK_MARKERS) {
        expect(message).not.toContain(marker);
      }
    }
  });
});
