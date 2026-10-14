import { useEffect, useState, useCallback, useMemo, useRef } from "react";

import type {
  DeepPartial,
  InferSchema,
  LocalLLMErrorCode,
  ModelAvailability,
  Schema,
  SessionConfig,
  TokenEvent,
  PartialEvent,
  StreamCompleteEvent,
  StreamErrorEvent,
  DownloadProgress,
  ToolDefinition,
  ToolCallEvent,
  ActiveToolCall,
} from "./ExpoLocalLlm.types";
import ExpoLocalLlmModule from "./ExpoLocalLlmModule";
import { createLLMSession, LLMSession } from "./LLMSession";
import { getModuleDiagnostics } from "./capabilities";
import { LocalLLMError, getLocalLLMErrorCode } from "./errors";
import { parseStructuredOutput } from "./validateSchema";

type UseLocalLLMOptions<Definition extends Schema> = Omit<
  SessionConfig,
  "schema"
> & {
  schema?: Definition;
};

type UseLocalLLMResult<Definition extends Schema> = {
  availability: ModelAvailability;
  session: LLMSession | null;
  isGenerating: boolean;
  streamedText: string;
  streamedJSON: string;
  /** The structured response so far, in JSON mode. Fields appear as the model produces them. */
  streamedObject: DeepPartial<InferSchema<Definition>> | null;
  /**
   * The finished structured response, in JSON mode, after it has been
   * validated against the schema. Null while generating and after a cancel.
   */
  completedObject: InferSchema<Definition> | null;
  downloadProgress: number | null;
  error: string | null;
  /** The code of `error`, or null when there is no error or it came from your own code. */
  errorCode: LocalLLMErrorCode | null;
  activeToolCalls: ActiveToolCall[];
  respond?: (prompt: string) => Promise<string>;
  streamResponse?: (prompt: string) => Promise<string>;
  cancelStream?: () => Promise<void>;
  reset?: () => void;
  downloadModel?: () => Promise<void>;
};

type HookError = {
  message: string;
  code: LocalLLMErrorCode | null;
};

/** Caught values that are not `Error`s keep a fallback message and no code. */
function toHookError(error: Error | null, fallbackMessage: string): HookError {
  return error
    ? { message: error.message, code: getLocalLLMErrorCode(error) }
    : { message: fallbackMessage, code: null };
}

type ActiveRequest = {
  id: string;
  epoch: number;
  kind: "respond" | "stream";
  session: LLMSession;
};

let requestSequence = 0;

function createRequestId(): string {
  requestSequence += 1;
  return `expo-local-llm-request-${requestSequence}`;
}

function readAvailability(): ModelAvailability {
  if (!ExpoLocalLlmModule) return "moduleUnavailable";
  try {
    // SAFETY: native implementations return the documented availability union.
    return ExpoLocalLlmModule.getAvailability() as ModelAvailability;
  } catch {
    return "unknown";
  }
}

export function useLocalLLM<const Definition extends Schema = Schema>(
  options: UseLocalLLMOptions<Definition> = {}
): UseLocalLLMResult<Definition> {
  const [availability, setAvailability] =
    useState<ModelAvailability>(readAvailability);
  const [session, setSession] = useState<LLMSession | null>(null);
  const [creationError, setCreationError] = useState<HookError | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [streamedText, setStreamedText] = useState("");
  const [streamedJSON, setStreamedJSON] = useState("");
  const [streamedObject, setStreamedObject] = useState<DeepPartial<
    InferSchema<Definition>
  > | null>(null);
  const [completedObject, setCompletedObject] =
    useState<InferSchema<Definition> | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<number | null>(null);
  const [runtimeError, setRuntimeError] = useState<HookError | null>(null);
  const [activeToolCalls, setActiveToolCalls] = useState<ActiveToolCall[]>([]);
  const activeRequestRef = useRef<ActiveRequest | null>(null);
  // A cancelled stream resolves with incomplete JSON, which must not be
  // validated as a final structured response.
  const cancelledRequestIdRef = useRef<string | null>(null);
  const lifecycleEpochRef = useRef(0);
  // The session the creation effect currently owns. A config change runs the
  // creation effect's cleanup — which releases the previous session — before
  // this hook's listener effect runs its setup, so the render-time `session`
  // value can already be released by then.
  const sessionRef = useRef<LLMSession | null>(null);

  // Keep a ref to the current tool handlers so the event listener
  // always sees the latest handlers without needing to recreate the session.
  const toolHandlersRef = useRef<Map<string, ToolDefinition["handler"]>>(
    new Map()
  );

  // Update handler ref whenever tools change
  useEffect(() => {
    const handlers = new Map<string, ToolDefinition["handler"]>();
    if (options.tools) {
      for (const tool of options.tools) {
        handlers.set(tool.name, tool.handler);
      }
    }
    toolHandlersRef.current = handlers;
  }, [options.tools]);

  // Stabilize options to avoid unnecessary session recreation
  // Include tool names/descriptions so session recreates when tools change structurally
  const toolsFingerprint = useMemo(
    () =>
      options.tools
        ?.map(
          (t) => `${t.name}:${t.description}:${JSON.stringify(t.parameters)}`
        )
        .join("|") ?? "",
    [options.tools]
  );

  // Fingerprint the schema so session recreates when it changes
  const schemaFingerprint = useMemo(
    () => (options.schema ? JSON.stringify(options.schema) : ""),
    [options.schema]
  );

  const stableConfig = useMemo(
    () => options,
    [
      options.instructions,
      options.options?.temperature,
      options.options?.maxTokens,
      options.options?.topK,
      options.toolTimeout,
      options.responseFormat,
      options.includeSchemaInPrompt,
      schemaFingerprint,
      toolsFingerprint,
    ]
  );

  const isJSONMode = options.responseFormat === "json" && !!options.schema;

  // Native shared objects have lifecycle side effects, so create them only
  // after commit. Creating in render/useMemo leaks sessions when React
  // abandons a render (notably under StrictMode).
  useEffect(() => {
    const nativeModule = ExpoLocalLlmModule;
    if (!nativeModule) return;
    let nextSession: LLMSession | null = null;
    try {
      nextSession = createLLMSession(stableConfig);
      sessionRef.current = nextSession;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- The native session is an effect-owned external resource; publishing it synchronously after acquisition prevents consumers from observing a not-yet-created handle.
      setCreationError(null);
      setIsGenerating(false);
      setActiveToolCalls([]);
      setSession(nextSession);
    } catch (error: unknown) {
      sessionRef.current = null;
      setSession(null);
      setCreationError(
        toHookError(
          error instanceof Error ? error : null,
          "Failed to create LLM session"
        )
      );
    }
    return () => {
      if (activeRequestRef.current?.session === nextSession) {
        lifecycleEpochRef.current += 1;
        activeRequestRef.current = null;
      }
      nextSession?.release();
    };
  }, [stableConfig]);
  const currentError = creationError ?? runtimeError;
  const schema = stableConfig.schema;

  useEffect(() => {
    const nativeModule = ExpoLocalLlmModule;
    if (!nativeModule) return;

    const subs: { remove(): void }[] = [];
    let disposed = false;

    subs.push(
      nativeModule.addListener(
        "downloadProgress",
        (event: DownloadProgress) => {
          setDownloadProgress(event.progress);
        }
      )
    );
    subs.push(
      nativeModule.addListener("availabilityChange", (event) => {
        setAvailability(event.availability);
      })
    );

    const refreshAvailability = () => {
      try {
        // SAFETY: native implementations return the documented availability union.
        setAvailability(nativeModule.getAvailability() as ModelAvailability);
      } catch (error: unknown) {
        setAvailability("unknown");
        setRuntimeError(
          toHookError(
            error instanceof Error ? error : null,
            "Failed to refresh model availability"
          )
        );
      }
    };
    const { AppState } = require("react-native");
    subs.push(
      AppState.addEventListener("change", (state: string) => {
        if (state === "active") refreshAvailability();
      })
    );

    // Subscribe first so a fast native transition caused by this synchronous
    // check cannot be missed between the check and listener installation.
    refreshAvailability();

    // Subscribe only when this render's session is still the object the creation
    // effect owns. After a config change the render-time value is the previous,
    // already-released session; subscribing to it throws on Android.
    if (session && session === sessionRef.current) {
      const hasCurrentRequest = (requestId: string | undefined) => {
        const request = activeRequestRef.current;
        return (
          !!requestId &&
          request?.id === requestId &&
          request.session === session &&
          request.epoch === lifecycleEpochRef.current
        );
      };
      const hasCurrentStream = (requestId: string | undefined) =>
        activeRequestRef.current?.kind === "stream" &&
        hasCurrentRequest(requestId);
      subs.push(
        session.addListener("token", (event: TokenEvent) => {
          if (!hasCurrentStream(event.requestId)) return;
          setStreamedText(event.accumulated);
        })
      );
      subs.push(
        session.addListener("partial", (event: PartialEvent) => {
          if (!hasCurrentStream(event.requestId)) return;
          setStreamedJSON(event.json);
          try {
            setStreamedObject(JSON.parse(event.json));
          } catch {
            // Partial may not be parseable yet; keep the previous parsed value.
          }
        })
      );
      subs.push(
        session.addListener("streamComplete", (event: StreamCompleteEvent) => {
          if (!hasCurrentStream(event.requestId)) return;
          if (isJSONMode) {
            setStreamedJSON(event.text);
            try {
              setStreamedObject(JSON.parse(event.text));
            } catch {
              // Final JSON should always parse; leave previous value if it doesn't.
            }
          } else {
            setStreamedText(event.text);
          }
        })
      );
      subs.push(
        session.addListener("streamError", (event: StreamErrorEvent) => {
          if (!hasCurrentStream(event.requestId)) return;
          setRuntimeError({ message: event.error, code: event.code });
        })
      );

      // Tool call event listener
      subs.push(
        session.addListener("toolCall", (event: ToolCallEvent) => {
          if (disposed || !hasCurrentRequest(event.requestId)) return;
          const request = activeRequestRef.current;
          if (!request) return;
          const activeCall = { callId: event.callId, toolName: event.toolName };
          setActiveToolCalls((prev) => [...prev, activeCall]);

          const removeActiveCall = () => {
            if (!hasCurrentRequest(request.id)) return;
            setActiveToolCalls((prev) =>
              prev.filter((c) => c.callId !== event.callId)
            );
          };

          const handler = toolHandlersRef.current.get(event.toolName);
          if (!handler) {
            removeActiveCall();
            try {
              session.rejectToolCall(
                event.callId,
                `No handler registered for tool: ${event.toolName}`
              );
            } catch {
              // Ignore if session is already torn down
            }
            return;
          }

          let result: Promise<string>;
          try {
            result = handler(event.arguments);
          } catch (e: any) {
            // Handler threw synchronously before returning a promise
            removeActiveCall();
            try {
              session.rejectToolCall(
                event.callId,
                e.message || "Tool handler failed"
              );
            } catch {
              // Ignore if session is already torn down
            }
            return;
          }

          result
            .then((value) => {
              if (disposed || !hasCurrentRequest(request.id)) return;
              removeActiveCall();
              session.resolveToolCall(event.callId, value);
            })
            .catch((e: any) => {
              if (disposed || !hasCurrentRequest(request.id)) return;
              removeActiveCall();
              try {
                session.rejectToolCall(
                  event.callId,
                  e.message || "Tool handler failed"
                );
              } catch {
                // Ignore if session is already torn down
              }
            });
        })
      );
    }

    return () => {
      disposed = true;
      subs.forEach((s) => s.remove());
    };
    // isJSONMode: used by the streamComplete listener. Today it can only
    // change together with a session recreation (responseFormat/schema are
    // in stableConfig), but depending on it directly removes the reliance
    // on that invariant.
  }, [session, isJSONMode]);

  const respond = useCallback(
    async (prompt: string): Promise<string> => {
      if (!session) {
        throw new LocalLLMError("ERR_SESSION_INVALID", "Session not available");
      }
      if (activeRequestRef.current) {
        throw new LocalLLMError(
          "ERR_SESSION_BUSY",
          "An LLM request is already in progress"
        );
      }
      const request: ActiveRequest = {
        id: createRequestId(),
        epoch: lifecycleEpochRef.current,
        kind: "respond",
        session,
      };
      activeRequestRef.current = request;
      setRuntimeError(null);
      setCompletedObject(null);
      setIsGenerating(true);
      try {
        const result = await session.respond(prompt, request.id);
        if (isJSONMode && schema) {
          const object = parseStructuredOutput(result, schema);
          if (activeRequestRef.current === request) {
            setCompletedObject(object);
          }
        }
        return result;
      } catch (error: unknown) {
        if (activeRequestRef.current === request) {
          setRuntimeError(
            toHookError(
              error instanceof Error ? error : null,
              "Generation failed"
            )
          );
        }
        throw error;
      } finally {
        if (
          activeRequestRef.current === request &&
          lifecycleEpochRef.current === request.epoch
        ) {
          activeRequestRef.current = null;
          setActiveToolCalls([]);
          setIsGenerating(false);
        }
      }
    },
    [session, isJSONMode, schema]
  );

  const streamResponse = useCallback(
    async (prompt: string): Promise<string> => {
      if (!session) {
        throw new LocalLLMError("ERR_SESSION_INVALID", "Session not available");
      }
      if (activeRequestRef.current) {
        throw new LocalLLMError(
          "ERR_SESSION_BUSY",
          "An LLM request is already in progress"
        );
      }
      const request: ActiveRequest = {
        id: createRequestId(),
        epoch: lifecycleEpochRef.current,
        kind: "stream",
        session,
      };
      activeRequestRef.current = request;
      setRuntimeError(null);
      setStreamedText("");
      setStreamedJSON("");
      setStreamedObject(null);
      setCompletedObject(null);
      setIsGenerating(true);
      try {
        // Resolves with the final text at stream end (or the partial text
        // if cancelled); rejects if the stream fails.
        const result = await session.streamResponse(prompt, request.id);
        if (
          activeRequestRef.current === request &&
          lifecycleEpochRef.current === request.epoch
        ) {
          if (isJSONMode && schema) {
            setStreamedJSON(result);
            if (cancelledRequestIdRef.current === request.id) {
              try {
                setStreamedObject(JSON.parse(result));
              } catch {
                // A cancelled stream's partial JSON may not parse yet.
              }
            } else {
              const object = parseStructuredOutput(result, schema);
              setStreamedObject(JSON.parse(result));
              setCompletedObject(object);
            }
          } else {
            setStreamedText(result);
          }
        }
        return result;
      } catch (error: unknown) {
        if (activeRequestRef.current === request) {
          setRuntimeError(
            toHookError(
              error instanceof Error ? error : null,
              "Streaming failed"
            )
          );
        }
        throw error;
      } finally {
        if (
          activeRequestRef.current === request &&
          lifecycleEpochRef.current === request.epoch
        ) {
          activeRequestRef.current = null;
          setActiveToolCalls([]);
          setIsGenerating(false);
        }
      }
    },
    [session, isJSONMode, schema]
  );

  const cancelStream = useCallback(async (): Promise<void> => {
    if (!session) return;
    const request = activeRequestRef.current;
    if (request?.kind === "stream") {
      cancelledRequestIdRef.current = request.id;
    }
    await session.cancelStream();
  }, [session]);

  const reset = useCallback((): void => {
    if (!session) return;
    lifecycleEpochRef.current += 1;
    activeRequestRef.current = null;
    session.reset();
    setStreamedText("");
    setStreamedJSON("");
    setStreamedObject(null);
    setCompletedObject(null);
    setRuntimeError(null);
    setActiveToolCalls([]);
    setIsGenerating(false);
  }, [session]);

  const downloadModel = useCallback(async (): Promise<void> => {
    if (!ExpoLocalLlmModule) return;
    await ExpoLocalLlmModule.downloadModel();
  }, []);

  if (!ExpoLocalLlmModule) {
    return {
      availability: "moduleUnavailable",
      session: null,
      isGenerating: false,
      streamedText: "",
      streamedJSON: "",
      streamedObject: null,
      completedObject: null,
      downloadProgress: null,
      error: getModuleDiagnostics().message,
      errorCode: "ERR_UNAVAILABLE",
      activeToolCalls: [],
    };
  }

  return {
    availability,
    session,
    isGenerating,
    streamedText,
    streamedJSON,
    streamedObject,
    completedObject,
    downloadProgress,
    error: currentError?.message ?? null,
    errorCode: currentError?.code ?? null,
    activeToolCalls,
    respond: session && availability === "available" ? respond : undefined,
    streamResponse:
      session && availability === "available" ? streamResponse : undefined,
    cancelStream: session ? cancelStream : undefined,
    // Resetting is safe in any availability state — gate on session only.
    reset: session ? reset : undefined,
    downloadModel,
  };
}
