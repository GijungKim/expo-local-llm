import { SharedObject, UnavailabilityError } from "expo-modules-core";

import type { SessionConfig, LLMSessionEvents } from "./ExpoLocalLlm.types";
import ExpoLocalLlmModule from "./ExpoLocalLlmModule";

export class LLMSession extends SharedObject<LLMSessionEvents> {
  // Methods are implemented natively via the Class() DSL.
  // TypeScript declarations provide type safety only.
  respond!: (prompt: string) => Promise<string>;
  streamResponse!: (prompt: string) => Promise<void>;
  cancelStream!: () => Promise<void>;
}

export function createLLMSession(config: SessionConfig = {}): LLMSession {
  if (!ExpoLocalLlmModule) {
    throw new UnavailabilityError("ExpoLocalLlm", "createLLMSession");
  }
  return new ExpoLocalLlmModule.LLMSession(config) as LLMSession;
}
