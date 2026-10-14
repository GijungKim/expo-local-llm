export type ModelAvailability =
  | "available"
  | "moduleUnavailable"
  | "notEnabled"
  | "notReady"
  | "notEligible"
  | "downloadRequired"
  | "downloading"
  | "unknown";

/**
 * Stable codes carried by every error this library raises, on both platforms.
 * Branch on these rather than on messages, which come from the OS and change.
 * Read one from any caught error with `getLocalLLMErrorCode`.
 */
export type LocalLLMErrorCode =
  /** The conversation no longer fits the model's context window. Reset or start a new session. */
  | "ERR_CONTEXT_WINDOW_EXCEEDED"
  /** The platform's safety guardrails blocked the prompt or the response. */
  | "ERR_GUARDRAIL_VIOLATION"
  /** The model declined to answer. */
  | "ERR_REFUSAL"
  /** The prompt's language or the device locale is not supported by the model. */
  | "ERR_UNSUPPORTED_LANGUAGE"
  /** The request uses a schema feature or capability the model cannot honour. */
  | "ERR_UNSUPPORTED_REQUEST"
  /** The system is throttling generation (quota, background use, or load). Retry later. */
  | "ERR_RATE_LIMITED"
  /** The model's assets are missing or the device cannot run it right now. */
  | "ERR_MODEL_UNAVAILABLE"
  /** The model's output could not be decoded into the requested structure. */
  | "ERR_DECODING_FAILED"
  /** Generation took longer than the system allows. */
  | "ERR_TIMEOUT"
  /** A tool call failed: the handler threw, timed out, or was unregistered. */
  | "ERR_TOOL_FAILED"
  /** Any other generation failure. */
  | "ERR_GENERATION_FAILED"
  /** This session already has a generation in progress. */
  | "ERR_SESSION_BUSY"
  /** The session was released or never initialised. */
  | "ERR_SESSION_INVALID"
  /** On-device generation is not available on this OS version. */
  | "ERR_NOT_SUPPORTED"
  /** `responseFormat: "json"` is not supported on this platform. */
  | "ERR_RESPONSE_FORMAT_NOT_SUPPORTED"
  /** Tool calling is not supported on this platform. */
  | "ERR_TOOL_NOT_SUPPORTED"
  /** Android only: downloading Gemini Nano failed. */
  | "ERR_MODEL_DOWNLOAD_FAILED"
  /** The schema passed to a session or `generateObject` is malformed. */
  | "ERR_SCHEMA_INVALID"
  /** The generated JSON did not match the schema. */
  | "ERR_STRUCTURED_OUTPUT_INVALID"
  /** The native module is missing from this build (Expo Go, or not rebuilt). */
  | "ERR_UNAVAILABLE";

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
  /** Allowed values for a `"string"` parameter. */
  enum?: readonly string[];
};

export type ToolParameters = Record<string, ToolParameter>;

export type InferToolParameter<Parameter extends ToolParameter> =
  Parameter extends {
    type: "string";
    enum: readonly (infer Value extends string)[];
  }
    ? Value
    : Parameter extends { type: "string" }
    ? string
    : Parameter extends { type: "number" }
    ? number
    : Parameter extends { type: "boolean" }
    ? boolean
    : never;

/**
 * Arguments the model supplied for a tool call. On iOS the model's decoding is
 * constrained to the tool's declared `parameters`, so every declared field is
 * present with its declared type and enum values are respected. Handlers
 * should still validate values that carry meaning (ranges, formats), as they
 * would for any other input.
 */
export type InferToolArguments<Parameters extends ToolParameters> = {
  -readonly [Key in keyof Parameters]: InferToolParameter<Parameters[Key]>;
};

/** Tool arguments when the tool's parameters are not known statically. */
export type ToolArguments = InferToolArguments<ToolParameters>;

/**
 * A tool the model can call. Declare tools with `defineTool()` to have the
 * handler's arguments typed from `parameters`.
 */
export type ToolDefinition<Parameters extends ToolParameters = ToolParameters> =
  {
    name: string;
    description: string;
    parameters: Parameters;
    // Method syntax keeps a tool with specific parameters assignable to the
    // general `ToolDefinition` that `tools` arrays hold.
    handler(args: InferToolArguments<Parameters>): Promise<string>;
  };

export type ToolConfig = {
  name: string;
  description: string;
  parameters: ToolParameters;
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

/**
 * An object still being generated: any field, at any depth, may be missing
 * until the model reaches it.
 */
export type DeepPartial<Value> = Value extends readonly (infer Item)[]
  ? DeepPartial<Item>[]
  : Value extends object
  ? { [Key in keyof Value]?: DeepPartial<Value[Key]> }
  : Value;

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
  /**
   * True where generation has not been verified on real hardware. Android is
   * experimental until Gemini Nano generation is validated on a device.
   */
  experimental: boolean;
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
  code: LocalLLMErrorCode;
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
