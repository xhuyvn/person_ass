import { describe, expect, it } from "vitest";
import { ApiClientError, createApi } from "../src/lib/api";
import { formatInstant, localDateTimeToIso, parseDateInput } from "../src/lib/format";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("format", () => {
  it("converts local datetime to +07:00 ISO and rejects junk", () => {
    expect(localDateTimeToIso("2026-10-22 09:00")).toBe("2026-10-22T09:00:00+07:00");
    expect(localDateTimeToIso("2026-02-30 09:00")).toBeNull();
    expect(localDateTimeToIso("2026-10-22 25:00")).toBeNull();
  });
  it("parses dd/mm/yyyy and ISO dates", () => {
    expect(parseDateInput("5/1/2027")).toBe("2027-01-05");
    expect(parseDateInput("2026-10-22")).toBe("2026-10-22");
    expect(parseDateInput("31/02/2026")).toBeNull();
  });
  it("formats instants in the personal timezone", () => {
    expect(formatInstant("2026-10-22T02:00:00.000Z")).toBe("22/10/2026 09:00");
  });
});

describe("api client", () => {
  it("sends an Idempotency-Key on create and validates the response", async () => {
    let seen: Headers | undefined;
    const task = {
      id: "6f1c1e0e-0000-4000-8000-000000000001", title: "a", description: null, status: "open", priority: 0,
      due_date: null, due_at: null, planned_at: null, completed_at: null, archived_at: null,
      version: 1, created_at: "x", updated_at: "x",
    };
    const api = createApi({
      baseUrl: "http://x/",
      fetchImpl: (async (_u: unknown, init: RequestInit) => {
        seen = new Headers(init.headers);
        return json(201, task);
      }) as unknown as typeof fetch,
    });
    const t = await api.createTask({ title: "a" });
    expect(t.title).toBe("a");
    expect(seen?.get("idempotency-key")).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
  });

  it("maps the error envelope to a display-safe error", async () => {
    const api = createApi({
      baseUrl: "http://x",
      fetchImpl: (async () =>
        json(409, { error: { code: "CONFLICT", message: "version lệch", retryable: false, correlation_id: "c" } })) as unknown as typeof fetch,
    });
    await expect(api.completeTask("6f1c1e0e-0000-4000-8000-000000000001", 1)).rejects.toMatchObject({
      name: "ApiClientError", status: 409, message: "version lệch",
    });
  });

  it("reports a network failure without leaking details", async () => {
    const api = createApi({ baseUrl: "http://x", fetchImpl: (async () => { throw new Error("secret detail"); }) as unknown as typeof fetch });
    const err = (await api.listTasks().catch((e: unknown) => e)) as ApiClientError;
    expect(err).toBeInstanceOf(ApiClientError);
    expect(err.message).not.toContain("secret");
  });
});
