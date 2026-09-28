import { SharedObject, UnavailabilityError } from "expo-modules-core";

import type {
  GenerateObjectConfig,
  InferSchema,
  Schema,
  SessionConfig,
  LLMSessionEvents,
  ToolConfig,
} from "./ExpoLocalLlm.types";
import ExpoLocalLlmModule from "./ExpoLocalLlmModule";
import { getCapabilities, getModuleDiagnostics } from "./capabilities";
import {
  validateSchema,
  validateStructuredOutput,
  SchemaInvalidError,
  StructuredOutputValidationError,
} from "./validateSchema";

export class NativeModuleUnavailableError extends UnavailabilityError {
  constructor(operation: string) {
    super("ExpoLocalLlm", operation);
    this.name = "NativeModuleUnavailableError";
    this.message = getModuleDiagnostics().message ?? this.message;
  }
}

export class LLMSession extends SharedObject<LLMSessionEvents> {
  // Methods are implemented natively via the Class() DSL.
  // TypeScript declarations provide type safety only.
  respond!: (prompt: string, requestId?: string) => Promise<string>;
  /**
   * Streams a response, emitting `token`/`partial` events along the way.
   * Resolves with the final text when the stream completes, or with the
   * partial text produced so far if the stream is cancelled via
   * `cancelStream()`. Rejects if the stream fails.
   */
  streamResponse!: (prompt: string, requestId?: string) => Promise<string>;
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
    throw new NativeModuleUnavailableError("createLLMSession");
  }

  if (config.responseFormat === "json" && !config.schema) {
    throw new SchemaInvalidError([
      {
        path: "schema",
        message: "responseFormat 'json' requires a schema",
      },
    ]);
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
    tools: config.tools?.map(({ handler: _handler, ...rest }) => rest),
  };
  // SAFETY: the native module exposes `LLMSession` as an untyped shared-object
  // class; its instances implement the `LLMSession` contract in this file.
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
  if (config.tools?.length) {
    throw new Error(
      "generate() does not support tools because one-shot generation cannot service tool-call handlers. Use useLocalLLM() instead."
    );
  }
  const session = createLLMSession(config);
  try {
    return await session.respond(prompt);
  } finally {
    session.release();
  }
}

export async function generateObject<const Definition extends Schema>(
  prompt: string,
  config: GenerateObjectConfig<Definition>
): Promise<InferSchema<Definition>> {
  const capabilities = getCapabilities();
  if (!capabilities.structuredOutput) {
    if (capabilities.status === "moduleUnavailable") {
      throw new NativeModuleUnavailableError("generateObject");
    }
    throw new Error(
      `Structured output is not supported on ${capabilities.platform}.`
    );
  }

  const text = await generate(prompt, {
    ...config,
    responseFormat: "json",
    schema: config.schema,
  });
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new StructuredOutputValidationError([
      {
        path: "$",
        message: `expected valid JSON (${
          error instanceof Error ? error.message : "parse failed"
        })`,
      },
    ]);
  }
  const validation = validateStructuredOutput(value, config.schema);
  if (!validation.ok) {
    throw new StructuredOutputValidationError(validation.errors);
  }
  // SAFETY: validateStructuredOutput recursively checked every field against
  // Definition immediately above, including nested containers and enums.
  return value as InferSchema<Definition>;
}
