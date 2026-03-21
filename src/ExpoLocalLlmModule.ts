import { NativeModule, requireNativeModule } from "expo-modules-core";

import type { ExpoLocalLlmModuleEvents } from "./ExpoLocalLlm.types";

declare class ExpoLocalLlmModuleType extends NativeModule<ExpoLocalLlmModuleEvents> {
  getAvailability(): string;
  downloadModel(): Promise<void>;
  LLMSession: any;
}

let nativeModule: ExpoLocalLlmModuleType | null;

try {
  nativeModule = requireNativeModule<ExpoLocalLlmModuleType>("ExpoLocalLlm");
} catch {
  nativeModule = null;
}

export default nativeModule;
