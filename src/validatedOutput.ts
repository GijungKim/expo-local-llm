import type {
  GenerateObjectConfig,
  InferSchema,
  LLMPrompt,
  Schema,
  SessionConfig,
} from "./ExpoLocalLlm.types";
import type { LLMSession } from "./LLMSession";
import { LocalLLMError } from "./errors";
import {
  parseStructuredOutput,
  StructuredOutputValidationError,
  snapshotSchema,
} from "./validateSchema";

// Character limits apply to JS strings, after the SDK returns its response.
const MAX_CHARACTERS = 65_536;

function checkLength(text: string, limit = MAX_CHARACTERS): void {
  if (text.length > limit) {
    throw new LocalLLMError(
      "ERR_UNSUPPORTED_REQUEST",
      `Validated output input, response, or repair context exceeds ${limit} characters.`
    );
  }
}

function hasPromptText(
  prompt: LLMPrompt
): prompt is Exclude<LLMPrompt, string> {
  return Object.prototype.hasOwnProperty.call(prompt, "text");
}

function abortError(): Error {
  const error = new Error("Validated generation was aborted.");
  error.name = "AbortError";
  return error;
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

async function respondOnce(
  prompt: LLMPrompt,
  config: SessionConfig,
  signal: AbortSignal | undefined,
  createSession: (config: SessionConfig) => LLMSession
): Promise<string> {
  checkAbort(signal);
  // A constructor can throw or synchronously trigger cancellation. Check again
  // after registering the listener, and always release a constructed session.
  const session = createSession(config);
  let onAbort = () => {};
  try {
    return await new Promise<string>((resolve, reject) => {
      onAbort = () => reject(abortError());
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      // Attach both handlers even if respond synchronously aborts, so a late
      // native rejection is observed. The outer finally owns the single release.
      session.respond(prompt).then(resolve, reject);
    });
  } finally {
    signal?.removeEventListener("abort", onAbort);
    // Native shared-object release already cancels the owned generation.
    session.release();
  }
}

export async function generateValidatedObject<const Definition extends Schema>(
  prompt: LLMPrompt,
  config: GenerateObjectConfig<Definition>,
  createSession: (config: SessionConfig) => LLMSession
): Promise<InferSchema<Definition>> {
  const { signal, repairAttempts = 1 } = config;
  checkAbort(signal);
  const schema = snapshotSchema(config.schema);
  const task = hasPromptText(prompt)
    ? {
        text: prompt.text,
        images: prompt.images?.map(({ uri, label }) => ({ uri, label })),
      }
    : { text: prompt };
  // Allowlist native text options. Runtime callers cannot override the format,
  // pass a native schema, or accidentally install tools/handlers on either turn.
  const nativeConfig: SessionConfig = {
    androidModel: config.androidModel,
    instructions: config.instructions,
    options: config.options ? { ...config.options } : undefined,
    responseFormat: "text",
  };
  const original = `${
    task.text
  }\n\nReturn only a bare JSON object matching this schema specification. Every key is required; no extra keys, markdown, or prose. Array items and nested objects must match their definitions; enums must use a listed value.\nSchema: ${JSON.stringify(
    schema
  )}`;
  let text = original;
  for (let attempt = 0; ; attempt++) {
    checkAbort(signal);
    checkLength(
      text +
        (nativeConfig.instructions ?? "") +
        JSON.stringify(task.images ?? [])
    );
    const response = await respondOnce(
      { ...task, text },
      nativeConfig,
      signal,
      createSession
    );
    checkAbort(signal);
    checkLength(response);
    try {
      return parseStructuredOutput(response, schema);
    } catch (error) {
      if (
        !(error instanceof StructuredOutputValidationError) ||
        attempt >= repairAttempts
      )
        throw error;
      text = `${original}\n\nThe previous response failed JSON/schema validation. Correct it and return only the complete JSON object.\nPrevious response: ${response}\nValidation errors: ${error.message}`;
      // The next iteration checks the complete repair context without truncation.
    }
  }
}
