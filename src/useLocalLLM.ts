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
  streamResponse?: (prompt: string) => Promise<void>;
  cancelStream?: () => Promise<void>;
  downloadModel?: () => Promise<void>;
};

export function useLocalLLM(
  options: UseLocalLLMOptions = {},
): UseLocalLLMResult {
  const [availability, setAvailability] = useState<ModelAvailability>(() =>
    ExpoLocalLlmModule
      ? (ExpoLocalLlmModule.getAvailability() as ModelAvailability)
      : "unknown",
  );
  const [isGenerating, setIsGenerating] = useState(false);
  const [streamedText, setStreamedText] = useState("");
  const [streamedJSON, setStreamedJSON] = useState("");
  const [streamedObject, setStreamedObject] = useState<unknown>(null);
  const [downloadProgress, setDownloadProgress] = useState<number | null>(null);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [activeToolCalls, setActiveToolCalls] = useState<ActiveToolCall[]>([]);

  // Keep a ref to the current tool handlers so the event listener
  // always sees the latest handlers without needing to recreate the session.
  const toolHandlersRef = useRef<Map<string, ToolDefinition["handler"]>>(
    new Map(),
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
          (t) => `${t.name}:${t.description}:${JSON.stringify(t.parameters)}`,
        )
        .join("|") ?? "",
    [options.tools],
  );

  // Fingerprint the schema so session recreates when it changes
  const schemaFingerprint = useMemo(
    () => (options.schema ? JSON.stringify(options.schema) : ""),
    [options.schema],
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
    ],
  );

  const isJSONMode = options.responseFormat === "json" && !!options.schema;

  const sessionResult = useMemo<{
    session: LLMSession | null;
    creationError: string | null;
  }>(() => {
    if (!ExpoLocalLlmModule) return { session: null, creationError: null };
    try {
      return { session: createLLMSession(stableConfig), creationError: null };
    } catch (e: any) {
      return {
        session: null,
        creationError: e.message ?? "Failed to create LLM session",
      };
    }
  }, [stableConfig]);
  const session = sessionResult.session;
  const error = sessionResult.creationError ?? runtimeError;

  // Module-level listeners are independent of the session, so subscribe once.
  // Keeping them out of the session effect avoids tearing them down (and briefly
  // missing events) every time the config changes and the session is recreated.
  useEffect(() => {
    if (!ExpoLocalLlmModule) return;

    const subs = [
      ExpoLocalLlmModule.addListener(
        "downloadProgress",
        (event: DownloadProgress) => {
          setDownloadProgress(event.progress);
        },
      ),
      ExpoLocalLlmModule.addListener("availabilityChange", (event) => {
        setAvailability(event.availability);
      }),
    ];

    return () => {
      subs.forEach((s) => s.remove());
    };
  }, []);

  useEffect(() => {
    if (!ExpoLocalLlmModule) return;

    const subs: { remove(): void }[] = [];

    if (session) {
      subs.push(
        session.addListener("token", (event: TokenEvent) => {
          setStreamedText(event.accumulated);
        }),
      );
      subs.push(
        session.addListener("partial", (event: PartialEvent) => {
          setStreamedJSON(event.json);
          try {
            setStreamedObject(JSON.parse(event.json));
          } catch {
            // Partial may not be parseable yet; keep the previous parsed value.
          }
        }),
      );
      subs.push(
        session.addListener("streamComplete", (event: StreamCompleteEvent) => {
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
          setIsGenerating(false);
        }),
      );
      subs.push(
        session.addListener("streamError", (event: StreamErrorEvent) => {
          setRuntimeError(event.error);
          setIsGenerating(false);
        }),
      );

      // Tool call event listener
      subs.push(
        session.addListener("toolCall", (event: ToolCallEvent) => {
          const activeCall = { callId: event.callId, toolName: event.toolName };
          setActiveToolCalls((prev) => [...prev, activeCall]);

          const removeActiveCall = () => {
            setActiveToolCalls((prev) =>
              prev.filter((c) => c.callId !== event.callId),
            );
          };

          const handler = toolHandlersRef.current.get(event.toolName);
          if (!handler) {
            removeActiveCall();
            try {
              session.rejectToolCall(
                event.callId,
                `No handler registered for tool: ${event.toolName}`,
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
                e.message || "Tool handler failed",
              );
            } catch {
              // Ignore if session is already torn down
            }
            return;
          }

          result
            .then((value) => {
              removeActiveCall();
              session.resolveToolCall(event.callId, value);
            })
            .catch((e: any) => {
              removeActiveCall();
              try {
                session.rejectToolCall(
                  event.callId,
                  e.message || "Tool handler failed",
                );
              } catch {
                // Ignore if session is already torn down
              }
            });
        }),
      );
    }

    return () => {
      subs.forEach((s) => s.remove());
      session?.release();
    };
  }, [session]);

  const respond = useCallback(
    async (prompt: string): Promise<string> => {
      if (!session) throw new Error("Session not available");
      setRuntimeError(null);
      setActiveToolCalls([]);
      setIsGenerating(true);
      try {
        const result = await session.respond(prompt);
        return result;
      } catch (e: any) {
        setRuntimeError(e.message);
        throw e;
      } finally {
        setIsGenerating(false);
      }
    },
    [session],
  );

  const streamResponse = useCallback(
    async (prompt: string): Promise<void> => {
      if (!session) throw new Error("Session not available");
      setRuntimeError(null);
      setStreamedText("");
      setStreamedJSON("");
      setStreamedObject(null);
      setActiveToolCalls([]);
      setIsGenerating(true);
      try {
        await session.streamResponse(prompt);
      } catch (e: any) {
        setRuntimeError(e.message);
        setIsGenerating(false);
        throw e;
      }
    },
    [session],
  );

  const cancelStream = useCallback(async (): Promise<void> => {
    if (!session) return;
    await session.cancelStream();
    setIsGenerating(false);
  }, [session]);

  const downloadModel = useCallback(async (): Promise<void> => {
    if (!ExpoLocalLlmModule) return;
    setRuntimeError(null);
    try {
      await ExpoLocalLlmModule.downloadModel();
    } catch (e: any) {
      setRuntimeError(e?.message ?? "Model download failed");
      throw e;
    }
  }, []);

  if (!ExpoLocalLlmModule) {
    return {
      availability: "notEligible",
      session: null,
      isGenerating: false,
      streamedText: "",
      streamedJSON: "",
      streamedObject: null,
      downloadProgress: null,
      error: null,
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
    cancelStream:
      session && availability === "available" ? cancelStream : undefined,
    downloadModel,
  };
}
