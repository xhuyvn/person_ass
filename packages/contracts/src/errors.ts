import { z } from "zod";
import type { ApiError, ApiErrorCode } from "./index.js";

export const correlationIdSchema = z.string().min(1);

export type ToErrorEnvelopeOptions = {
  fieldErrors?: Record<string, string>;
  retryable?: boolean;
  correlationId?: string;
};

/**
 * Build the API error envelope described in docs/03 §4:
 * { error: { code, message, field_errors?, retryable, correlation_id } }
 */
export function toErrorEnvelope(
  code: ApiErrorCode,
  message: string,
  opts: ToErrorEnvelopeOptions = {},
): ApiError {
  const retryable = opts.retryable ?? defaultRetryable(code);
  const envelope: ApiError = {
    error: {
      code,
      message,
      retryable,
      correlation_id: opts.correlationId ?? "",
    },
  };
  if (opts.fieldErrors && Object.keys(opts.fieldErrors).length > 0) {
    envelope.error.field_errors = opts.fieldErrors;
  }
  return envelope;
}

function defaultRetryable(code: ApiErrorCode): boolean {
  switch (code) {
    case "RATE_LIMITED":
    case "INTERNAL_ERROR":
      return true;
    default:
      return false;
  }
}
