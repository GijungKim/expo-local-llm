import { useEffect, useState, useCallback, useMemo, useRef } from "react";

import type {
  ModelAvailability,
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

type UseLocalLLMOptions = SessionConfig;

type UseLocalLLMResult = {
  availability: ModelAvailability;
  session: LLMSession | null;
  isGenerating: boolean;
  streamedText: string;
  streamedJSON: string;
  streamedObject: unknown;
  downloadProgress: number | null;
  error: string | null;
  activeToolCalls: ActiveToolCall[];
  respond?: (prompt: string) => Promise<string>;
  streamResponse?: (prompt: string) => Promise<string>;
  cancelStream?: () => Promise<void>;
  reset?: () => void;
  downloadModel?: () => Promise<void>;
};

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

export function useLocalLLM(
  options: UseLocalLLMOptions = {}
): UseLocalLLMResult {
  const [availability, setAvailability] =
    useState<ModelAvailability>(readAvailability);
  const [session, setSession] = useState<LLMSession | null>(null);
  const [creationError, setCreationError] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [streamedText, setStreamedText] = useState("");
  const [streamedJSON, setStreamedJSON] = useState("");
  const [streamedObject, setStreamedObject] = useState<unknown>(null);
  const [downloadProgress, setDownloadProgress] = useState<number | null>(null);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [activeToolCalls, setActiveToolCalls] = useState<ActiveToolCall[]>([]);
  const activeRequestRef = useRef<ActiveRequest | null>(null);
  const lifecycleEpochRef = useRef(0);

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
      // eslint-disable-next-line react-hooks/set-state-in-effect -- The native session is an effect-owned external resource; publishing it synchronously after acquisition prevents consumers from observing a not-yet-created handle.
      setCreationError(null);
      setIsGenerating(false);
      setActiveToolCalls([]);
      setSession(nextSession);
    } catch (e: any) {
      setSession(null);
      setCreationError(e.message ?? "Failed to create LLM session");
    }
    return () => {
      if (activeRequestRef.current?.session === nextSession) {
        lifecycleEpochRef.current += 1;
        activeRequestRef.current = null;
      }
      nextSession?.release();
    };
  }, [stableConfig]);
  const error = creationError ?? runtimeError;

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
          error instanceof Error
            ? error.message
            : "Failed to refresh model availability"
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

    if (session) {
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
          setRuntimeError(event.error);
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
      if (!session) throw new Error("Session not available");
      if (activeRequestRef.current) {
        throw new Error("An LLM request is already in progress");
      }
      const request: ActiveRequest = {
        id: createRequestId(),
        epoch: lifecycleEpochRef.current,
        kind: "respond",
        session,
      };
      activeRequestRef.current = request;
      setRuntimeError(null);
      setIsGenerating(true);
      try {
        const result = await session.respond(prompt, request.id);
        return result;
      } catch (error: unknown) {
        if (activeRequestRef.current === request) {
          setRuntimeError(
            error instanceof Error ? error.message : "Generation failed"
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
    [session]
  );

  const streamResponse = useCallback(
    async (prompt: string): Promise<string> => {
      if (!session) throw new Error("Session not available");
      if (activeRequestRef.current) {
        throw new Error("An LLM request is already in progress");
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
      setIsGenerating(true);
      try {
        // Resolves with the final text at stream end (or the partial text
        // if cancelled); rejects if the stream fails.
        const result = await session.streamResponse(prompt, request.id);
        if (
          activeRequestRef.current === request &&
          lifecycleEpochRef.current === request.epoch
        ) {
          if (isJSONMode) {
            setStreamedJSON(result);
            try {
              setStreamedObject(JSON.parse(result));
            } catch {
              // Native structured output errors are surfaced by the promise.
            }
          } else {
            setStreamedText(result);
          }
        }
        return result;
      } catch (error: unknown) {
        if (activeRequestRef.current === request) {
          setRuntimeError(
            error instanceof Error ? error.message : "Streaming failed"
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
    [session, isJSONMode]
  );

  const cancelStream = useCallback(async (): Promise<void> => {
    if (!session) return;
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
      downloadProgress: null,
      error: getModuleDiagnostics().message,
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
    downloadProgress,
    error,
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
