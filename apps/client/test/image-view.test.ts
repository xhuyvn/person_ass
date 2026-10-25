import { describe, expect, it } from "vitest";
import type { Job, OcrRun, ProposalAction, SourceDetail } from "@personalass/contracts";
import { createApi } from "../src/lib/api";
import {
  MAX_IMAGE_BYTES,
  describeCorrectionResult,
  describeOcr,
  describeSource,
  evidenceImages,
  evidenceLabel,
  precheckImages,
  sourceEntity,
  splitOcrText,
} from "../src/lib/image-view";
import { describeAction, describeJob, describeStatus } from "../src/lib/memo-view";

const ID = "6f1c1e0e-0000-4000-8000-000000000001";
const RUN2 = "6f1c1e0e-0000-4000-8000-000000000002";

const run = (over: Partial<OcrRun> = {}): OcrRun => ({
  id: ID,
  attachment_id: ID,
  author: "ai",
  status: "readable",
  text: "Mua sữa 2 hộp",
  blocks: [],
  uncertainties: [],
  model_id: "m",
  supersedes_run_id: null,
  created_at: "x",
  ...over,
});

describe("precheckImages", () => {
  const ok = { name: "a.png", type: "image/png", size: 1000 };
  it("accepts JPEG/PNG/WebP and rejects other types with a Vietnamese message", () => {
    const r = precheckImages(0, [ok, { name: "b.gif", type: "image/gif", size: 10 }, { name: "c.webp", type: "image/webp", size: 10 }]);
    expect(r.accepted).toEqual([0, 2]);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain("b.gif");
    expect(r.errors[0]).toContain("JPEG, PNG hoặc WebP");
  });
  it("rejects files over 10 MB and empty files", () => {
    const r = precheckImages(0, [{ ...ok, size: MAX_IMAGE_BYTES }, { ...ok, size: MAX_IMAGE_BYTES + 1 }, { ...ok, size: 0 }]);
    expect(r.accepted).toEqual([0]);
    expect(r.errors).toHaveLength(2);
  });
  it("caps at 10 images per memo counting already picked ones", () => {
    const files = Array.from({ length: 5 }, (_, i) => ({ ...ok, name: `${i}.png` }));
    const r = precheckImages(8, files);
    expect(r.accepted).toEqual([0, 1]);
    expect(r.errors).toHaveLength(3);
    expect(r.errors[0]).toContain("tối đa 10 ảnh");
  });
});

describe("describeOcr", () => {
  it("says not read yet when there is no run", () => {
    expect(describeOcr(null)).toMatchObject({ status: "Chưa đọc chữ", author: null, text: "", uncertain: [] });
  });
  it("labels status and author", () => {
    expect(describeOcr(run())).toMatchObject({ status: "Đọc được", author: "AI đọc", tone: "ok" });
    expect(describeOcr(run({ status: "partial", author: "user" }))).toMatchObject({ status: "Đọc được một phần", author: "Bạn đã sửa", tone: "warn" });
    expect(describeOcr(run({ status: "unreadable" }))).toMatchObject({ status: "Không đọc được chữ", tone: "error" });
  });
  it("marks uncertain fragments with a text prefix, not only colour", () => {
    const v = describeOcr(run({ uncertainties: [{ fragment: "2 hộp", reason: "mờ", alternatives: ["3 hộp", "2 hợp"] }] }));
    expect(v.uncertain[0]?.line.startsWith("⚠ chưa chắc:")).toBe(true);
    expect(v.uncertain[0]?.line).toContain("“3 hộp”");
  });
});

describe("splitOcrText", () => {
  it("splits around uncertain fragments in order and ignores missing/overlapping ones", () => {
    expect(splitOcrText("Mua sữa 2 hộp", ["2 hộp", "không có", "sữa 2"])).toEqual([
      { text: "Mua sữa ", uncertain: false },
      { text: "2 hộp", uncertain: true },
    ]);
    expect(splitOcrText("abc", [])).toEqual([{ text: "abc", uncertain: false }]);
    expect(splitOcrText("", ["x"])).toEqual([{ text: "", uncertain: false }]);
  });
});

describe("correction result", () => {
  it("describes every reprocess outcome", () => {
    expect(describeCorrectionResult("queued")).toContain("Đang xử lý lại");
    expect(describeCorrectionResult("busy")).toContain("bấm Xử lý lại sau");
    expect(describeCorrectionResult("skipped")).toContain("không xử lý lại");
  });
});

describe("evidence -> image number", () => {
  const atts = [
    { position: 0, ocr: run({ id: ID }) },
    { position: 2, ocr: run({ id: RUN2 }) },
  ];
  it("maps quoted OCR runs to 1-based image numbers", () => {
    const e = { evidence: [{ quote: "q", ocr_run_id: RUN2 }, { quote: "q", ocr_run_id: ID }, { quote: "t", ocr_run_id: null }] };
    expect(evidenceImages(e, atts)).toEqual({ numbers: [1, 3], unknown: false });
    expect(evidenceLabel(e, atts)).toBe("từ ảnh #1, #3");
  });
  it("returns null for text-only evidence and a generic label for an older run", () => {
    expect(evidenceLabel({ evidence: [{ quote: "t", ocr_run_id: null }] }, atts)).toBeNull();
    expect(evidenceLabel({ evidence: [{ quote: "q", ocr_run_id: "6f1c1e0e-0000-4000-8000-0000000000ff" }] }, atts)).toBe("từ ảnh");
  });
});

describe("source view", () => {
  const src = (over: Partial<SourceDetail>): SourceDetail => ({
    memo_id: ID,
    memo_revision_id: ID,
    quote: "Mua sữa",
    field_path: null,
    attachment_id: ID,
    attachment_position: 1,
    ocr_run: run(),
    ocr_run_is_latest: true,
    created_at: "x",
    ...over,
  });
  it("shows image number and OCR text of the quoted run", () => {
    expect(describeSource(src({}))).toMatchObject({ quote: "Mua sữa", imageLabel: "Ảnh #2", ocrText: "Mua sữa 2 hộp", note: null });
  });
  it("notes when the image text was corrected afterwards", () => {
    expect(describeSource(src({ ocr_run_is_latest: false })).note).toBe("Chữ ảnh đã được sửa sau đó");
  });
  it("has no image info for a text-only source", () => {
    expect(describeSource(src({ attachment_id: null, attachment_position: null, ocr_run: null, ocr_run_is_latest: null }))).toMatchObject({ imageLabel: null, attachmentId: null, ocrText: null, note: null });
  });
  it("offers a source only for applied, not undone, supported results", () => {
    const a = { status: "applied" as const, reason: null, result_entity_type: "task", result_entity_id: ID };
    expect(sourceEntity(a)).toEqual({ type: "task", id: ID });
    expect(sourceEntity({ ...a, reason: "undone" })).toBeNull();
    expect(sourceEntity({ ...a, status: "rejected" as const })).toBeNull();
    expect(sourceEntity({ ...a, result_entity_type: "person" })).toBeNull();
  });
});

describe("memo-view M3 labels", () => {
  it("labels the new action reasons", () => {
    const base: Omit<ProposalAction, "reason"> = { id: ID, proposal_id: ID, operation: "create", entity_type: "task", target_id: null, status: "rejected", fields: {}, evidence: [], result_entity_type: null, result_entity_id: null, action_group_id: null, created_at: "x" };
    expect(describeStatus({ ...base, reason: "ocr_uncertain" })).toContain("chữ trong ảnh chưa chắc chắn");
    expect(describeStatus({ ...base, reason: "superseded" })).toContain("đã thay bằng lần xử lý mới");
    expect(describeAction({ ...base, reason: null }, null)).toContain("Việc");
  });
  it("points no_image_input at the AI settings", () => {
    const job = { id: ID, kind: "process_memo", memo_revision_id: ID, state: "waiting_configuration", attempt: 0, max_attempts: 3, run_after: "x", error_code: "no_image_input", error_message: "x", created_at: "x", updated_at: "x" } as Job;
    const v = describeJob(job);
    expect(v.needsSettings).toBe(true);
    expect(v.text).toContain("Cài đặt AI");
    expect(v.text).toContain("OCR");
  });
});

describe("api client M3", () => {
  const receipt = { attachment_id: ID, attachment_token: "t".repeat(24), expires_at: "x", mime: "image/png", bytes: 3, width: 1, height: 1, sha256: "s" };
  it("uploads FormData without a manual content-type", async () => {
    let init: RequestInit | undefined;
    const api = createApi({
      baseUrl: "http://x/",
      fetchImpl: (async (_u: string, i: RequestInit) => {
        init = i;
        return new Response(JSON.stringify(receipt), { status: 201 });
      }) as unknown as typeof fetch,
    });
    const r = await api.uploadAttachment(new Blob(["abc"], { type: "image/png" }), "a.png");
    expect(r.attachment_token).toBe(receipt.attachment_token);
    expect(init?.body).toBeInstanceOf(FormData);
    expect((init?.body as FormData).get("file")).toBeInstanceOf(Blob);
    expect(new Headers(init?.headers).has("content-type")).toBe(false);
  });
  it("sends attachment_tokens only when present and builds content URLs", async () => {
    const bodies: unknown[] = [];
    const api = createApi({
      baseUrl: "http://x/",
      fetchImpl: (async (_u: string, i: RequestInit) => {
        bodies.push(JSON.parse(String(i.body)));
        return new Response(JSON.stringify({ memo_id: ID, revision_id: ID, job_id: null, state: "saved" }), { status: 201 });
      }) as unknown as typeof fetch,
    });
    await api.createMemo("", "2026-10-21T01:00:00.000Z", "Asia/Ho_Chi_Minh", ID, { attachmentTokens: ["a".repeat(20), "b".repeat(20)] });
    await api.createMemo("x", "2026-10-21T01:00:00.000Z", "Asia/Ho_Chi_Minh", ID);
    expect(bodies[0]).toMatchObject({ text: "", attachment_tokens: ["a".repeat(20), "b".repeat(20)] });
    expect(bodies[1]).not.toHaveProperty("attachment_tokens");
    expect(api.attachmentUrl("/api/v1/attachments/1/content")).toBe("http://x/api/v1/attachments/1/content");
  });
  it("calls correction and sources endpoints and surfaces 409 as ApiClientError", async () => {
    const calls: Array<{ url: string; method: string | undefined; body: unknown }> = [];
    const api = createApi({
      baseUrl: "http://x",
      fetchImpl: (async (url: string, i: RequestInit) => {
        calls.push({ url, method: i.method, body: i.body ? JSON.parse(String(i.body)) : undefined });
        if (url.includes("ocr-corrections")) {
          return new Response(JSON.stringify({ error: { code: "conflict", message: "Có bản mới hơn." } }), { status: 409 });
        }
        return new Response(JSON.stringify({ items: [] }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    await expect(api.correctOcr(ID, { text: "x", expected_run_id: null })).rejects.toMatchObject({ status: 409 });
    expect(calls[0]?.body).toMatchObject({ text: "x", expected_run_id: null, reprocess: true });
    expect(await api.sources("task", ID)).toEqual([]);
    expect(calls[1]?.url).toBe(`http://x/api/v1/sources?entity_type=task&entity_id=${ID}`);
    expect(await api.ocrRuns(ID)).toEqual([]);
    expect(calls[2]?.url).toBe(`http://x/api/v1/attachments/${ID}/ocr-runs`);
  });
});
