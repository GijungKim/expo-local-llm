import { SharedObject, UnavailabilityError } from "expo-modules-core";

import type {
  SessionConfig,
  LLMSessionEvents,
  ToolConfig,
} from "./ExpoLocalLlm.types";
import ExpoLocalLlmModule from "./ExpoLocalLlmModule";

export class LLMSession extends SharedObject<LLMSessionEvents> {
  // Methods are implemented natively via the Class() DSL.
  // TypeScript declarations provide type safety only.
  respond!: (prompt: string) => Promise<string>;
  streamResponse!: (prompt: string) => Promise<void>;
  cancelStream!: () => Promise<void>;
  registerTool!: (config: ToolConfig) => void;
  unregisterTool!: (name: string) => void;
  resolveToolCall!: (callId: string, result: string) => void;
  rejectToolCall!: (callId: string, error: string) => void;
}

export function createLLMSession(config: SessionConfig = {}): LLMSession {
  if (!ExpoLocalLlmModule) {
    throw new UnavailabilityError("ExpoLocalLlm", "createLLMSession");
  }

  // Strip handler functions before passing to native — native doesn't need them
  const nativeConfig = {
    ...config,
    tools: config.tools?.map(({ handler, ...rest }) => rest),
  };
  return new ExpoLocalLlmModule.LLMSession(nativeConfig) as LLMSession;
}
