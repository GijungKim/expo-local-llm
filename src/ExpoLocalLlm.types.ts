export type ModelAvailability =
  | "available"
  | "notEnabled"
  | "notReady"
  | "notEligible"
  | "downloadRequired"
  | "downloading"
  | "unknown";

export type GenerationOptions = {
  temperature?: number;
  maxTokens?: number;
  topK?: number;
};

export type SessionConfig = {
  instructions?: string;
  options?: GenerationOptions;
};

export type TokenEvent = {
  token: string;
  accumulated: string;
};

export type StreamCompleteEvent = {
  text: string;
};

export type StreamErrorEvent = {
  error: string;
};

export type DownloadProgress = {
  progress: number;
};

export type LLMSessionEvents = {
  token: (event: TokenEvent) => void;
  streamComplete: (event: StreamCompleteEvent) => void;
  streamError: (event: StreamErrorEvent) => void;
};

export type ExpoLocalLlmModuleEvents = {
  downloadProgress: (event: DownloadProgress) => void;
  availabilityChange: (event: { availability: ModelAvailability }) => void;
};
