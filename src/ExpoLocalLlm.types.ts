export type ModelAvailability =
  | "available"
  | "moduleUnavailable"
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

/**
 * Arguments the model supplied for a tool call, parsed from the JSON it
 * produced. The values are NOT validated against the tool's declared
 * `parameters` — the model may omit fields, add extras, or use a different
 * primitive type — so handlers should treat them as untrusted input.
 */
export type ToolArguments = Record<string, unknown>;

export type ToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, ToolParameter>;
  handler: (args: ToolArguments) => Promise<string>;
};

export type ToolConfig = {
  name: string;
  description: string;
  parameters: Record<string, ToolParameter>;
};

export type ToolCallEvent = {
  requestId?: string;
  callId: string;
  toolName: string;
  arguments: ToolArguments;
};

export type ActiveToolCall = {
  callId: string;
  toolName: string;
};

// Structured output types

export type ResponseFormat = "text" | "json";

export type SchemaField =
  | { type: "string"; description?: string; enum?: readonly string[] }
  | { type: "number" | "integer" | "boolean"; description?: string }
  | { type: "array"; description?: string; items: SchemaField }
  | {
      type: "object";
      description?: string;
      properties: Record<string, SchemaField>;
    };

export type Schema = Record<string, SchemaField>;

export type InferSchemaField<Field extends SchemaField> = Field extends {
  type: "string";
  enum: readonly (infer Value extends string)[];
}
  ? Value
  : Field extends { type: "string" }
  ? string
  : Field extends { type: "number" | "integer" }
  ? number
  : Field extends { type: "boolean" }
  ? boolean
  : Field extends { type: "array"; items: infer Item extends SchemaField }
  ? InferSchemaField<Item>[]
  : Field extends {
      type: "object";
      properties: infer Properties extends Schema;
    }
  ? InferSchema<Properties>
  : never;

export type InferSchema<Definition extends Schema> = {
  -readonly [Key in keyof Definition]: InferSchemaField<Definition[Key]>;
};

export type GenerateObjectConfig<Definition extends Schema> = Omit<
  SessionConfig,
  "responseFormat" | "schema" | "tools"
> & {
  schema: Definition;
  /** One-shot helpers cannot service native tool-call events. */
  tools?: never;
};

export type NativeModuleDiagnostics =
  | {
      available: true;
      reason: null;
      message: null;
      setupInstructions: readonly [];
    }
  | {
      available: false;
      reason: "moduleUnavailable";
      message: string;
      setupInstructions: readonly string[];
    };

export type LocalLLMCapabilities = {
  platform: "ios" | "android" | "unsupported";
  backend: "appleFoundationModels" | "geminiNano" | null;
  status:
    | "available"
    | "moduleUnavailable"
    | "unsupportedOS"
    | "unsupportedPlatform";
  text: boolean;
  streaming: boolean;
  tools: boolean;
  structuredOutput: boolean;
  structuredOutputMode: "constrained" | "unsupported";
};

export type SessionConfig = {
  instructions?: string;
  options?: GenerationOptions;
  tools?: ToolDefinition[];
  toolTimeout?: number;
  responseFormat?: ResponseFormat;
  schema?: Schema;
  includeSchemaInPrompt?: boolean;
};

export type TokenEvent = {
  requestId?: string;
  token: string;
  accumulated: string;
};

export type StreamCompleteEvent = {
  requestId?: string;
  text: string;
};

export type PartialEvent = {
  requestId?: string;
  json: string;
  complete: boolean;
};

export type StreamErrorEvent = {
  requestId?: string;
  error: string;
};

export type DownloadProgress = {
  progress: number;
};

export type LLMSessionEvents = {
  token: (event: TokenEvent) => void;
  partial: (event: PartialEvent) => void;
  streamComplete: (event: StreamCompleteEvent) => void;
  streamError: (event: StreamErrorEvent) => void;
  toolCall: (event: ToolCallEvent) => void;
};

export type ExpoLocalLlmModuleEvents = {
  downloadProgress: (event: DownloadProgress) => void;
  availabilityChange: (event: { availability: ModelAvailability }) => void;
};
