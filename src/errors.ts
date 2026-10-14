import type { LocalLLMErrorCode } from "./ExpoLocalLlm.types";

const ERROR_CODES: readonly LocalLLMErrorCode[] = [
  "ERR_CONTEXT_WINDOW_EXCEEDED",
  "ERR_GUARDRAIL_VIOLATION",
  "ERR_REFUSAL",
  "ERR_UNSUPPORTED_LANGUAGE",
  "ERR_UNSUPPORTED_REQUEST",
  "ERR_RATE_LIMITED",
  "ERR_MODEL_UNAVAILABLE",
  "ERR_DECODING_FAILED",
  "ERR_TIMEOUT",
  "ERR_TOOL_FAILED",
  "ERR_GENERATION_FAILED",
  "ERR_SESSION_BUSY",
  "ERR_SESSION_INVALID",
  "ERR_NOT_SUPPORTED",
  "ERR_RESPONSE_FORMAT_NOT_SUPPORTED",
  "ERR_TOOL_NOT_SUPPORTED",
  "ERR_MODEL_DOWNLOAD_FAILED",
  "ERR_SCHEMA_INVALID",
  "ERR_STRUCTURED_OUTPUT_INVALID",
  "ERR_UNAVAILABLE",
];

/** An error raised by this library's JavaScript layer, coded like native errors. */
export class LocalLLMError extends Error {
  readonly code: LocalLLMErrorCode;

  constructor(code: LocalLLMErrorCode, message: string) {
    super(message);
    this.name = "LocalLLMError";
    this.code = code;
  }
}

/**
 * The `LocalLLMErrorCode` of an error thrown or rejected by this library, or
 * null for any other error (including ones thrown by your own tool handlers).
 *
 * ```ts
 * try {
 *   await session.respond(prompt);
 * } catch (error) {
 *   if (
 *     error instanceof Error &&
 *     getLocalLLMErrorCode(error) === "ERR_CONTEXT_WINDOW_EXCEEDED"
 *   ) {
 *     session.reset();
 *   }
 * }
 * ```
 */
export function getLocalLLMErrorCode(error: Error): LocalLLMErrorCode | null {
  if (!("code" in error)) return null;
  return ERROR_CODES.find((code) => code === error.code) ?? null;
}
