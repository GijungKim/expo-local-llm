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

// Tool calling types

export type ToolParameterType = "string" | "number" | "boolean";

export type ToolParameter = {
  type: ToolParameterType;
  description: string;
  enum?: string[];
};

export type ToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, ToolParameter>;
  handler: (args: Record<string, any>) => Promise<string>;
};

export type ToolConfig = {
  name: string;
  description: string;
  parameters: Record<string, ToolParameter>;
};

export type ToolCallEvent = {
  callId: string;
  toolName: string;
  arguments: Record<string, any>;
};

export type ActiveToolCall = {
  callId: string;
  toolName: string;
};

// Structured output types

export type ResponseFormat = "text" | "json";

export type SessionConfig = {
  instructions?: string;
  options?: GenerationOptions;
  tools?: ToolDefinition[];
  toolTimeout?: number;
  responseFormat?: ResponseFormat;
  schema?: Record<string, any>;
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
  toolCall: (event: ToolCallEvent) => void;
};

export type ExpoLocalLlmModuleEvents = {
  downloadProgress: (event: DownloadProgress) => void;
  availabilityChange: (event: { availability: ModelAvailability }) => void;
};
