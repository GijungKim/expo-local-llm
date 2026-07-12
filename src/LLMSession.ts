import { SharedObject, UnavailabilityError } from "expo-modules-core";

import type {
  SessionConfig,
  LLMSessionEvents,
  ToolConfig,
} from "./ExpoLocalLlm.types";
import ExpoLocalLlmModule from "./ExpoLocalLlmModule";
import { validateSchema, SchemaInvalidError } from "./validateSchema";

export class LLMSession extends SharedObject<LLMSessionEvents> {
  // Methods are implemented natively via the Class() DSL.
  // TypeScript declarations provide type safety only.
  respond!: (prompt: string) => Promise<string>;
  /**
   * Streams a response, emitting `token`/`partial` events along the way.
   * Resolves with the final text when the stream completes, or with the
   * partial text produced so far if the stream is cancelled via
   * `cancelStream()`. Rejects if the stream fails.
   */
  streamResponse!: (prompt: string) => Promise<string>;
  cancelStream!: () => Promise<void>;
  /**
   * Clears the conversation transcript while keeping instructions, tools,
   * schema, and generation options. Cancels any in-flight stream. Cheap —
   * the model weights are OS-shared; only the conversation state is rebuilt.
   */
  reset!: () => void;
  registerTool!: (config: ToolConfig) => void;
  unregisterTool!: (name: string) => void;
  resolveToolCall!: (callId: string, result: string) => void;
  rejectToolCall!: (callId: string, error: string) => void;
}

export function createLLMSession(config: SessionConfig = {}): LLMSession {
  if (!ExpoLocalLlmModule) {
    throw new UnavailabilityError("ExpoLocalLlm", "createLLMSession");
  }

  if (config.schema) {
    const result = validateSchema(config.schema);
    if (!result.ok) {
      throw new SchemaInvalidError(result.errors);
    }
  }

  // Strip handler functions before passing to native — native doesn't need them
  const nativeConfig = {
    ...config,
    tools: config.tools?.map(({ handler, ...rest }) => rest),
  };
  return new ExpoLocalLlmModule.LLMSession(nativeConfig) as LLMSession;
}

/**
 * One-shot, stateless generation: creates a session, responds once, and
 * releases the session. Use this for classification/extraction calls where
 * conversation history is unwanted — no session bookkeeping, no transcript
 * accumulation across calls.
 *
 * Throws `UnavailabilityError` when the native module is missing; rejects
 * with the native error when the model is not available. Callers that need
 * an availability check first can use `ExpoLocalLlmModule.getAvailability()`.
 */
export async function generate(
  prompt: string,
  config: SessionConfig = {}
): Promise<string> {
  const session = createLLMSession(config);
  try {
    return await session.respond(prompt);
  } finally {
    session.release();
  }
}
