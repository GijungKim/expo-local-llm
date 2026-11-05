import { NativeModule, requireNativeModule } from "expo-modules-core";

import type {
  AndroidModel,
  ModelAvailability,
  ModelReadiness,
  ExpoLocalLlmModuleEvents,
} from "./ExpoLocalLlm.types";

declare class ExpoLocalLlmModuleType extends NativeModule<ExpoLocalLlmModuleEvents> {
  getAvailability(androidModel?: AndroidModel): ModelAvailability;
  getToolCallingVersion?(): number;
  getModelReadiness?(androidModel?: AndroidModel): Promise<ModelReadiness>;
  supportsImages?(): boolean;
  getImagePromptVersion?(): number;
  downloadModel(androidModel?: AndroidModel): Promise<void>;
  LLMSession: any;
}

let nativeModule: ExpoLocalLlmModuleType | null;
let nativeModuleLoadError: Error | null = null;

try {
  nativeModule = requireNativeModule<ExpoLocalLlmModuleType>("ExpoLocalLlm");
} catch (error) {
  nativeModule = null;
  nativeModuleLoadError =
    error instanceof Error
      ? error
      : new Error("Unknown native module loader error");
}

export { nativeModuleLoadError };
export default nativeModule;
