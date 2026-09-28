import type {
  LocalLLMCapabilities,
  NativeModuleDiagnostics,
} from "./ExpoLocalLlm.types";
import ExpoLocalLlmModule, {
  nativeModuleLoadError,
} from "./ExpoLocalLlmModule";

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
      tools: false,
      structuredOutput: false,
      structuredOutputMode: "unsupported",
    };
  }

  const isIOS = platform === "ios";
  const available = diagnostics.available;
  const supportedOS =
    !isIOS || Number.parseInt(String(nativePlatform.Version), 10) >= 26;
  const supported = available && supportedOS;
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
    tools: supported && isIOS,
    structuredOutput: supported && isIOS,
    structuredOutputMode: supported && isIOS ? "constrained" : "unsupported",
  };
}
