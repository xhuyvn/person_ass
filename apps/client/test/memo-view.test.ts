import { describe, expect, it } from "vitest";
import type { Clarification, Job, ProposalAction } from "@personalass/contracts";
import { createApi } from "../src/lib/api";
import { answerFields, buildAnswerFields, describeAction, describeJob, describeStatus, undoGroups } from "../src/lib/memo-view";

const ID = "6f1c1e0e-0000-4000-8000-000000000001";

const job = (over: Partial<Job>): Job => ({
  id: ID,
  kind: "process_memo",
  memo_revision_id: ID,
  state: "queued",
  attempt: 0,
  max_attempts: 3,
  run_after: "2026-10-21T01:00:30.000Z",
  error_code: null,
  error_message: null,
  created_at: "x",
  updated_at: "x",
  ...over,
});

const act = (over: Partial<ProposalAction>): ProposalAction => ({
  id: ID,
  proposal_id: ID,
  operation: "create",
  entity_type: "task",
  target_id: null,
  status: "applied",
  reason: null,
  fields: {},
  evidence: [],
  result_entity_type: null,
  result_entity_id: null,
  action_group_id: null,
  created_at: "x",
  ...over,
});

describe("describeJob", () => {
  it("marks queued/running/retry as active and points configuration problems to settings", () => {
    expect(describeJob(job({ state: "running", attempt: 1 }))).toMatchObject({ active: true, text: "Đang xử lý (lần 1/3)…" });
    expect(describeJob(job({ state: "retry_wait", error_message: "HTTP 503" })).text).toContain("21/10/2026 08:00");
    expect(describeJob(job({ state: "waiting_configuration", error_message: "Chưa chọn model" }))).toMatchObject({ needsSettings: true, active: false });
    expect(describeJob(job({ state: "failed", error_message: "x" }))).toMatchObject({ tone: "error", canReprocess: true });
    expect(describeJob(null)).toMatchObject({ active: false, text: "Chỉ lưu, không xử lý AI." });
  });
});

describe("actions", () => {
  it("describes what the AI proposed in Vietnamese with local dates", () => {
    expect(describeAction(act({ fields: { title: "Mua sữa" } }))).toBe("Việc · Mua sữa · không có hạn");
    expect(describeAction(act({ entity_type: "appointment", fields: { title: "Họp", starts_at: "2026-10-22T09:00:00+07:00" } }))).toBe(
      "Lịch hẹn · Họp · 22/10/2026 09:00",
    );
    expect(describeAction(act({ operation: "update", entity_type: "appointment", fields: { status: "cancelled" } }))).toBe("Lịch hẹn (sửa) · → cancelled");
    expect(describeAction(act({ operation: "update", entity_type: "appointment", fields: { starts_at: "2026-11-12T10:00:00+07:00" } }), "Khám răng")).toBe(
      "Lịch hẹn (sửa) · Khám răng · 12/11/2026 10:00",
    );
    expect(describeStatus(act({ status: "rejected", reason: "entity_type_not_supported_yet" }))).toContain("chưa được hỗ trợ");
    expect(describeStatus(act({ status: "applied", reason: "undone" }))).toBe("đã hoàn tác");
  });

  it("offers one undo per applied action group, none after undo", () => {
    const groups = undoGroups([
      act({ action_group_id: "g1" }),
      act({ action_group_id: "g1" }),
      act({ action_group_id: "g2", reason: "undone" }),
      act({ action_group_id: "g3", status: "needs_clarification" }),
    ]);
    expect([...groups.entries()]).toEqual([["g1", 2]]);
  });
});

describe("clarification answers", () => {
  const clar = (field_path: string | null): Clarification => ({
    id: ID,
    proposal_action_id: ID,
    kind: "missing_fields",
    field_path,
    question: "?",
    options: [],
    state: "open",
    version: 1,
    created_at: "x",
  });

  it("builds inputs from field_path and falls back by entity type", () => {
    expect(answerFields(clar("starts_at"), undefined).map((f) => f.path)).toEqual(["starts_at"]);
    expect(answerFields(clar(null), act({ entity_type: "task" })).map((f) => f.path)).toEqual(["due_date"]);
    expect(answerFields(clar("bogus"), act({ entity_type: "appointment" })).map((f) => f.path)).toEqual(["starts_at"]);
  });

  it("converts typed values to API values and rejects bad input", () => {
    const fields = answerFields(clar("starts_at,due_date"), undefined);
    expect(buildAnswerFields(fields, { starts_at: "2026-11-12 09:00", due_date: "12/11/2026" })).toEqual({
      fields: { starts_at: "2026-11-12T09:00:00+07:00", due_date: "2026-11-12" },
    });
    expect(buildAnswerFields(fields, { starts_at: "12/11", due_date: "12/11/2026" })).toHaveProperty("error");
    expect(buildAnswerFields(fields, { starts_at: "2026-11-12 09:00" })).toHaveProperty("error");
  });
});

describe("api client M2", () => {
  it("sends AI processing on by default and never reads a key back", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const api = createApi({
      baseUrl: "http://x",
      fetchImpl: (async (url: string, init: RequestInit) => {
        calls.push({ url, body: init.body ? JSON.parse(String(init.body)) : undefined });
        if (url.endsWith("/memos")) {
          return new Response(JSON.stringify({ memo_id: ID, revision_id: ID, job_id: ID, state: "queued" }), { status: 201 });
        }
        return new Response(JSON.stringify({ action_group_id: ID, state: "undone", reverted: [] }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    const r = await api.createMemo("Mua sữa", "2026-10-21T01:00:00.000Z", "Asia/Ho_Chi_Minh", ID);
    expect(r.state).toBe("queued");
    expect(calls[0]?.body).toMatchObject({ process: true, privacy: "default" });
    await api.createMemo("x", "2026-10-21T01:00:00.000Z", "Asia/Ho_Chi_Minh", ID, { privacy: "local_only" });
    expect(calls[1]?.body).toMatchObject({ privacy: "local_only" });
    await api.undoActionGroup(ID);
    expect(calls[2]?.url).toBe(`http://x/api/v1/action-groups/${ID}/undo`);
  });
});
