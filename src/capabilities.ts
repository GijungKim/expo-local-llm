import type {
  AndroidModel,
  ModelReadiness,
  LocalLLMCapabilities,
  NativeModuleDiagnostics,
} from "./ExpoLocalLlm.types";
import ExpoLocalLlmModule, {
  nativeModuleLoadError,
} from "./ExpoLocalLlmModule";
import { LocalLLMError } from "./errors";

const SETUP_INSTRUCTIONS = [
  "Use an Expo development build; Expo Go cannot load expo-local-llm's native module.",
  "After installing or upgrading expo-local-llm, rebuild the native iOS or Android app.",
] as const;

export function getModuleDiagnostics(): NativeModuleDiagnostics {
  if (ExpoLocalLlmModule) {
    return {
      available: true,
      reason: null,
      message: null,
      setupInstructions: [],
    };
  }

  const detail =
    nativeModuleLoadError instanceof Error
      ? ` Native loader error: ${nativeModuleLoadError.message}`
      : "";
  return {
    available: false,
    reason: "moduleUnavailable",
    message: `The ExpoLocalLlm native module is unavailable.${detail} ${SETUP_INSTRUCTIONS.join(
      " "
    )}`,
    setupInstructions: SETUP_INSTRUCTIONS,
  };
}

export function getCapabilities(): LocalLLMCapabilities {
  const diagnostics = getModuleDiagnostics();
  // Load lazily so setup diagnostics remain usable in non-native tooling
  // (Node, SSR, and docs generation) where React Native is not resolvable.
  const nativePlatform = require("react-native").Platform;
  const platform: string = nativePlatform.OS;

  if (platform !== "ios" && platform !== "android") {
    return {
      platform: "unsupported",
      backend: null,
      status: "unsupportedPlatform",
      text: false,
      streaming: false,
      images: "unsupported",
      tools: false,
      structuredOutput: false,
      structuredOutputMode: "unsupported",
      objectGenerationMode: "unsupported",
      experimental: false,
    };
  }

  const isIOS = platform === "ios";
  const available = diagnostics.available;
  const supportedOS =
    !isIOS || Number.parseInt(String(nativePlatform.Version), 10) >= 26;
  const supported = available && supportedOS;
  let images: LocalLLMCapabilities["images"] = "unsupported";
  if (
    isIOS &&
    supported &&
    Number.parseInt(String(nativePlatform.Version), 10) >= 27
  ) {
    if (ExpoLocalLlmModule?.supportsImages?.()) {
      images = "supported";
    }
  } else if (!isIOS && available) {
    try {
      if (
        ExpoLocalLlmModule?.getImagePromptVersion?.() === 1 &&
        ExpoLocalLlmModule.getAvailability() === "available"
      ) {
        images = "unknown";
      }
    } catch {
      // Availability can fail while Android's model service is starting.
    }
  }
  return {
    platform,
    backend: isIOS ? "appleFoundationModels" : "geminiNano",
    status: !available
      ? "moduleUnavailable"
      : supportedOS
      ? "available"
      : "unsupportedOS",
    text: supported,
    streaming: supported,
    images,
    tools:
      supported &&
      (isIOS || ExpoLocalLlmModule?.getToolCallingVersion?.() === 1),
    structuredOutput: supported && isIOS,
    structuredOutputMode: supported && isIOS ? "constrained" : "unsupported",
    objectGenerationMode: supported
      ? isIOS
        ? "constrained"
        : "validated"
      : "unsupported",
    experimental: !isIOS,
  };
}

/** Fail explicitly instead of letting an older binary silently select default. */
export function assertAndroidModelSupport(androidModel?: AndroidModel): void {
  const nativePlatform = require("react-native").Platform;
  if (
    nativePlatform.OS === "android" &&
    androidModel &&
    androidModel !== "default" &&
    (androidModel !== "previewFast" ||
      ExpoLocalLlmModule?.getToolCallingVersion?.() !== 1)
  ) {
    throw new LocalLLMError(
      "ERR_UNSUPPORTED_REQUEST",
      "This Android build cannot select previewFast. Rebuild with native tool calling version 1."
    );
  }
}

export async function getModelReadiness(
  androidModel: AndroidModel = "default"
): Promise<ModelReadiness> {
  if (!ExpoLocalLlmModule)
    return { availability: "moduleUnavailable", tools: "unavailable" };
  assertAndroidModelSupport(androidModel);
  const nativePlatform = require("react-native").Platform;
  if (
    nativePlatform.OS === "android" &&
    ExpoLocalLlmModule.getToolCallingVersion?.() === 1 &&
    ExpoLocalLlmModule.getModelReadiness
  ) {
    try {
      return await ExpoLocalLlmModule.getModelReadiness(androidModel);
    } catch {
      return { availability: "unknown", tools: "unknown" };
    }
  }
  if (
    nativePlatform.OS === "android" &&
    ExpoLocalLlmModule.getToolCallingVersion?.() === 1
  ) {
    return { availability: "unknown", tools: "unknown" };
  }
  try {
    return {
      availability: ExpoLocalLlmModule.getAvailability(),
      tools: getCapabilities().tools ? "available" : "unavailable",
    };
  } catch {
    return { availability: "unknown", tools: "unknown" };
  }
}
