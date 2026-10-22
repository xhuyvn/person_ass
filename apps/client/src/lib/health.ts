import { healthReadySchema, type HealthReady } from "@personalass/contracts";

/**
 * Pure health-check logic for the client.
 *
 * This module must stay free of react-native imports and JSX so it can be
 * unit tested in a plain node environment. Every failure is reported as a
 * short, Vietnamese, display-safe message: no stack traces, no raw response
 * bodies, no internal details.
 */

export type HealthErrorReason =
  | "network"
  | "timeout"
  | "invalid_payload"
  | "http_error";

export type HealthResult =
  | { status: "ok"; data: HealthReady }
  | {
      status: "error";
      reason: HealthErrorReason;
      message: string;
    };

export type CheckHealthOptions = {
  baseUrl: string;
  /** Endpoint path appended to baseUrl. Defaults to "/health/ready". */
  path?: string;
  /** Request timeout in milliseconds. Defaults to 5000. */
  timeoutMs?: number;
  /** Injectable fetch implementation (tests). Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** Optional external abort signal. */
  signal?: AbortSignal;
};

const DEFAULT_PATH = "/health/ready";
const DEFAULT_TIMEOUT_MS = 5000;

class HealthTimeoutError extends Error {
  constructor() {
    super("health check timed out");
    this.name = "HealthTimeoutError";
  }
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

function formatSeconds(timeoutMs: number): string {
  const seconds = timeoutMs / 1000;
  return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)}s`;
}

/** Join baseUrl and path without producing a double slash. */
export function joinHealthUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${base}${suffix}`;
}

export async function checkHealth(
  options: CheckHealthOptions,
): Promise<HealthResult> {
  const requestPath = options.path ?? DEFAULT_PATH;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const url = joinHealthUrl(options.baseUrl, requestPath);

  const controller = new AbortController();
  const externalSignal = options.signal;
  const abortFromExternal = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener("abort", abortFromExternal, { once: true });
  }

  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new HealthTimeoutError());
    }, timeoutMs);
  });
  // The timeout promise may reject after the request already settled; mark it
  // as handled so Node does not report an unhandled rejection.
  timeoutPromise.catch(() => undefined);

  try {
    const response = await Promise.race([
      fetchImpl(url, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: controller.signal,
      }),
      timeoutPromise,
    ]);

    if (!response.ok) {
      // Never expose the raw body: it may contain internal details.
      return {
        status: "error",
        reason: "http_error",
        message: `Máy chủ trả về lỗi HTTP ${response.status}.`,
      };
    }

    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      raw = undefined;
    }

    const parsed = healthReadySchema.safeParse(raw);
    if (!parsed.success) {
      return {
        status: "error",
        reason: "invalid_payload",
        message:
          "Máy chủ trả về dữ liệu không hợp lệ (không khớp lược đồ dự kiến).",
      };
    }

    return { status: "ok", data: parsed.data };
  } catch (error) {
    if (timedOut || error instanceof HealthTimeoutError) {
      return {
        status: "error",
        reason: "timeout",
        message: `Yêu cầu quá thời gian (${formatSeconds(timeoutMs)}).`,
      };
    }
    if (isAbortError(error)) {
      return {
        status: "error",
        reason: "timeout",
        message: "Yêu cầu đã bị hủy trước khi hoàn tất.",
      };
    }
    return {
      status: "error",
      reason: "network",
      message: "Không kết nối được máy chủ. Backend có đang chạy không?",
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (externalSignal) {
      externalSignal.removeEventListener("abort", abortFromExternal);
    }
  }
}
