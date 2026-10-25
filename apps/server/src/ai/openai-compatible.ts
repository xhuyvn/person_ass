import type { AiConnectionKind, AiModel, StructuredOutput } from "@personalass/contracts";
import { ProviderError, sanitizeProviderText, toProviderError } from "./errors.js";
import type { HttpResponse, Transport } from "./net-policy.js";

/**
 * Minimal OpenAI-compatible client (Chat Completions + /models) for
 * OpenRouter, Ollama (local/LAN/cloud) and custom endpoints (docs/04 §1).
 * Only the subset every target supports is used; unsupported parameters are
 * dropped instead of switching models silently.
 */
export type ResolvedConnection = {
  id: string;
  kind: AiConnectionKind;
  baseUrl: string;
  allowedHosts: string[];
  /** Decrypted only for the duration of a call; never stored or logged. */
  apiKey: string | null;
  timeoutMs: number;
  structuredOutput: StructuredOutput;
};

/** Image parts carry a data: URL only; images are never published to get a URL (docs/04 §2). */
export type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string | ContentPart[] };

export type ChatRequest = {
  model: string;
  messages: ChatMessage[];
  maxTokens: number;
  temperature: number | null;
  /** JSON Schema of the expected answer, used when native structured output is on. */
  jsonSchema?: { name: string; schema: Record<string, unknown> };
};

export type ChatResult = {
  content: string;
  usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
  latencyMs: number;
};

/** Ollama ignores the key but some SDK paths require one (docs/04 §1). */
const OLLAMA_PLACEHOLDER_KEY = "ollama";

export class OpenAiCompatibleClient {
  constructor(
    private readonly conn: ResolvedConnection,
    private readonly transport: Transport,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = { accept: "application/json", "content-type": "application/json" };
    const key = this.conn.apiKey ?? (this.conn.kind === "ollama_local" ? OLLAMA_PLACEHOLDER_KEY : null);
    if (key) h.authorization = `Bearer ${key}`;
    return h;
  }

  private async send(method: "GET" | "POST", path: string, body?: unknown): Promise<HttpResponse> {
    try {
      return await this.transport({
        method,
        url: `${this.conn.baseUrl}${path}`,
        headers: this.headers(),
        body: body === undefined ? undefined : JSON.stringify(body),
        timeoutMs: this.conn.timeoutMs,
        allowedHosts: this.conn.allowedHosts,
      });
    } catch (err) {
      throw toProviderError(err);
    }
  }

  private fail(res: HttpResponse, withImages = false): never {
    const detail = sanitizeProviderText(extractErrorMessage(res.body), this.conn.apiKey ? [this.conn.apiKey] : []);
    const suffix = detail ? `: ${detail}` : "";
    if (res.status >= 300 && res.status < 400) {
      throw new ProviderError("blocked_by_policy", "Provider trả về chuyển hướng; không đi theo redirect.");
    }
    if (res.status === 401 || res.status === 403) {
      throw new ProviderError("auth", `Provider từ chối xác thực (HTTP ${res.status}). Kiểm tra API key${suffix}`);
    }
    if (res.status === 404) {
      throw new ProviderError("model_not_found", `Không tìm thấy model hoặc endpoint (HTTP 404)${suffix}`);
    }
    if (res.status === 429) {
      throw new ProviderError("rate_limited", `Provider giới hạn tần suất (HTTP 429)${suffix}`, parseRetryAfter(res.headers["retry-after"], this.now()));
    }
    if (res.status >= 500 || res.status === 408) {
      throw new ProviderError("unavailable", `Provider lỗi tạm thời (HTTP ${res.status})${suffix}`, parseRetryAfter(res.headers["retry-after"], this.now()));
    }
    if (withImages && (res.status === 400 || res.status === 422) && IMAGE_REJECTION.test(extractErrorMessage(res.body))) {
      throw new ProviderError("no_image_input", `Model không nhận ảnh đầu vào; chọn model có khả năng đọc ảnh cho vai trò OCR${suffix}`);
    }
    throw new ProviderError("bad_request", `Provider từ chối yêu cầu (HTTP ${res.status})${suffix}`);
  }

  async listModels(): Promise<AiModel[]> {
    const res = await this.send("GET", "/models");
    if (res.status !== 200) this.fail(res);
    const parsed = parseJson(res.body) as { data?: unknown } | null;
    if (!parsed || !Array.isArray(parsed.data)) {
      throw new ProviderError("invalid_response", "Danh sách model không đúng định dạng OpenAI-compatible.");
    }
    const items: AiModel[] = [];
    for (const m of parsed.data as Array<Record<string, unknown>>) {
      if (typeof m?.id !== "string" || m.id.length === 0) continue;
      items.push({ id: m.id, capabilities: capabilitiesOf(m) });
    }
    return items;
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const mode = this.conn.structuredOutput;
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages,
      max_tokens: req.maxTokens,
      stream: false,
    };
    if (req.temperature !== null) body.temperature = req.temperature;
    if (req.jsonSchema && (mode === "auto" || mode === "json_schema")) {
      body.response_format = {
        type: "json_schema",
        json_schema: { name: req.jsonSchema.name, schema: req.jsonSchema.schema, strict: false },
      };
    } else if (req.jsonSchema && mode === "json_object") {
      body.response_format = { type: "json_object" };
    }
    const started = this.now();
    let res = await this.send("POST", "/chat/completions", body);
    if (mode === "auto" && body.response_format && (res.status === 400 || res.status === 422)) {
      // Endpoint does not support native structured output: ask for JSON in
      // the prompt only; the backend validates either way (docs/04 §8).
      delete body.response_format;
      res = await this.send("POST", "/chat/completions", body);
    }
    if (res.status !== 200) this.fail(res, hasImages(req.messages));
    const parsed = parseJson(res.body) as {
      choices?: Array<{ message?: { content?: unknown } }>;
      usage?: Record<string, unknown>;
      error?: unknown;
    } | null;
    if (!parsed) throw new ProviderError("invalid_response", "Phản hồi của provider không phải JSON.");
    if (parsed.error) {
      throw new ProviderError("unavailable", `Provider báo lỗi: ${sanitizeProviderText(extractErrorMessage(res.body))}`);
    }
    const content = messageText(parsed.choices?.[0]?.message?.content);
    if (content === null) throw new ProviderError("invalid_response", "Phản hồi không có nội dung trả lời.");
    return { content, usage: normalizeUsage(parsed.usage), latencyMs: Math.max(0, this.now() - started) };
  }
}

/** Provider wording for "this model cannot take images" (OpenRouter, Ollama, vLLM-style servers). */
const IMAGE_REJECTION =
  /((not|n't|no)\s+(support|accept|allow)\w*|unsupported|no endpoints?)[^.]{0,60}(image|vision|multimodal|modalit)|(image|vision|multimodal|modalit)\w*[^.]{0,60}(not\s+(supported|allowed|accepted)|unsupported)/i;

function hasImages(messages: ChatMessage[]): boolean {
  return messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === "image_url"));
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractErrorMessage(body: string): string {
  const parsed = parseJson(body) as { error?: unknown; message?: unknown } | null;
  if (parsed && typeof parsed === "object") {
    const e = parsed.error;
    if (typeof e === "string") return e;
    if (e && typeof e === "object" && typeof (e as { message?: unknown }).message === "string") {
      return (e as { message: string }).message;
    }
    if (typeof parsed.message === "string") return parsed.message;
  }
  return "";
}

export function parseRetryAfter(value: string | undefined, nowMs: number): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 3600_000);
  const at = Date.parse(value);
  if (Number.isFinite(at)) return Math.min(Math.max(0, at - nowMs), 3600_000);
  return null;
}

function messageText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = content
      .map((p) => (p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : ""))
      .join("");
    return parts.length > 0 ? parts : null;
  }
  return null;
}

function normalizeUsage(u: Record<string, unknown> | undefined): ChatResult["usage"] {
  if (!u || typeof u !== "object") return null;
  const pick = (k: string): number | undefined => (typeof u[k] === "number" ? (u[k] as number) : undefined);
  return { prompt_tokens: pick("prompt_tokens"), completion_tokens: pick("completion_tokens"), total_tokens: pick("total_tokens") };
}

/** Capability hints when the provider publishes them (OpenRouter); else unknown. */
function capabilitiesOf(m: Record<string, unknown>): AiModel["capabilities"] {
  const arch = m.architecture as { input_modalities?: unknown } | undefined;
  const params = Array.isArray(m.supported_parameters) ? (m.supported_parameters as unknown[]) : null;
  const modalities = Array.isArray(arch?.input_modalities) ? (arch?.input_modalities as unknown[]) : null;
  return {
    image_input: modalities ? (modalities.includes("image") ? "yes" : "no") : "unknown",
    json_schema: params ? (params.includes("structured_outputs") || params.includes("response_format") ? "yes" : "no") : "unknown",
    tools: params ? (params.includes("tools") ? "yes" : "no") : "unknown",
  };
}
