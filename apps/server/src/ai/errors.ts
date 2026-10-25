import type { ProviderErrorDto } from "@personalass/contracts";

export type ProviderErrorCode = ProviderErrorDto["code"];

/**
 * Normalized provider failure. `message` is always secret-free and short; it
 * is what the API, the job row and the log may show (docs/02 §5).
 */
export class ProviderError extends Error {
  constructor(
    readonly code: ProviderErrorCode,
    message: string,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
  }

  toDto(): ProviderErrorDto {
    return { code: this.code, message: this.message };
  }
}

/** Errors worth another attempt later (docs/02 §4: 429/5xx/network). */
export const isRetryable = (code: ProviderErrorCode): boolean =>
  code === "rate_limited" || code === "unavailable" || code === "timeout";

/** Errors that need the owner to fix the configuration; never spam retries. */
export const needsConfiguration = (code: ProviderErrorCode): boolean =>
  code === "auth" ||
  code === "model_not_found" ||
  code === "not_configured" ||
  code === "blocked_by_policy" ||
  code === "no_image_input";

const KEY_PATTERNS = [/sk-[A-Za-z0-9_\-]{6,}/g, /Bearer\s+\S+/gi, /key[=:]\s*\S+/gi];

/** Strip anything key-like from provider text and cap its length. */
export function sanitizeProviderText(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join("[redacted]");
  for (const p of KEY_PATTERNS) out = out.replace(p, "[redacted]");
  out = out.replace(/\s+/g, " ").trim();
  return out.length > 300 ? `${out.slice(0, 300)}…` : out;
}

/** Map a low-level error (network, our own ProviderError) to a ProviderError. */
export function toProviderError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  const code = (err as { code?: string }).code;
  if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT") {
    return new ProviderError("timeout", "Provider không phản hồi trong thời gian cho phép.");
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return new ProviderError("unavailable", "Không phân giải được tên máy chủ của provider.");
  }
  if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "EHOSTUNREACH" || code === "ENETUNREACH") {
    return new ProviderError("unavailable", "Không kết nối được tới provider.");
  }
  return new ProviderError("unavailable", "Lỗi mạng khi gọi provider.");
}
