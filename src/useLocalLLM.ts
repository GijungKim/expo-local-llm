import { useEffect, useState, useCallback, useMemo, useRef } from "react";

import type {
  ModelAvailability,
  SessionConfig,
  TokenEvent,
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
  downloadProgress: number | null;
  error: string | null;
  activeToolCalls: ActiveToolCall[];
  respond?: (prompt: string) => Promise<string>;
  streamResponse?: (prompt: string) => Promise<void>;
  cancelStream?: () => Promise<void>;
  downloadModel?: () => Promise<void>;
};

export function useLocalLLM(
  options: UseLocalLLMOptions = {}
): UseLocalLLMResult {
  const [availability, setAvailability] =
    useState<ModelAvailability>("unknown");
  const [isGenerating, setIsGenerating] = useState(false);
  const [streamedText, setStreamedText] = useState("");
  const [downloadProgress, setDownloadProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeToolCalls, setActiveToolCalls] = useState<ActiveToolCall[]>([]);

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
        ?.map((t) => `${t.name}:${t.description}:${JSON.stringify(t.parameters)}`)
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
      schemaFingerprint,
      toolsFingerprint,
    ]
  );

  const session = useMemo(() => {
    if (!ExpoLocalLlmModule) return null;
    try {
      const s = createLLMSession(stableConfig);
      setError(null);
      return s;
    } catch (e: any) {
      setError(e.message ?? "Failed to create LLM session");
      return null;
    }
  }, [stableConfig]);

  useEffect(() => {
    if (!ExpoLocalLlmModule) return;

    setAvailability(ExpoLocalLlmModule.getAvailability() as ModelAvailability);

    const subs: { remove(): void }[] = [];

    subs.push(
      ExpoLocalLlmModule.addListener(
        "downloadProgress",
        (event: DownloadProgress) => {
          setDownloadProgress(event.progress);
        }
      )
    );
    subs.push(
      ExpoLocalLlmModule.addListener("availabilityChange", (event) => {
        setAvailability(event.availability);
      })
    );

    if (session) {
      subs.push(
        session.addListener("token", (event: TokenEvent) => {
          setStreamedText(event.accumulated);
        })
      );
      subs.push(
        session.addListener("streamComplete", (event: StreamCompleteEvent) => {
          setStreamedText(event.text);
          setIsGenerating(false);
        })
      );
      subs.push(
        session.addListener("streamError", (event: StreamErrorEvent) => {
          setError(event.error);
          setIsGenerating(false);
        })
      );

      // Tool call event listener
      subs.push(
        session.addListener("toolCall", (event: ToolCallEvent) => {
          const activeCall = { callId: event.callId, toolName: event.toolName };
          setActiveToolCalls((prev) => [...prev, activeCall]);

          const removeActiveCall = () => {
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
              removeActiveCall();
              session.resolveToolCall(event.callId, value);
            })
            .catch((e: any) => {
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
      subs.forEach((s) => s.remove());
      session?.release();
    };
  }, [session]);

  const respond = useCallback(
    async (prompt: string): Promise<string> => {
      if (!session) throw new Error("Session not available");
      setError(null);
      setIsGenerating(true);
      try {
        const result = await session.respond(prompt);
        return result;
      } catch (e: any) {
        setError(e.message);
        throw e;
      } finally {
        setIsGenerating(false);
      }
    },
    [session]
  );

  const streamResponse = useCallback(
    async (prompt: string): Promise<void> => {
      if (!session) throw new Error("Session not available");
      setError(null);
      setStreamedText("");
      setIsGenerating(true);
      try {
        await session.streamResponse(prompt);
      } catch (e: any) {
        setError(e.message);
        setIsGenerating(false);
        throw e;
      }
    },
    [session]
  );

  const cancelStream = useCallback(async (): Promise<void> => {
    if (!session) return;
    await session.cancelStream();
    setIsGenerating(false);
  }, [session]);

  const downloadModel = useCallback(async (): Promise<void> => {
    if (!ExpoLocalLlmModule) return;
    await ExpoLocalLlmModule.downloadModel();
  }, []);

  if (!ExpoLocalLlmModule) {
    return {
      availability: "notEligible",
      session: null,
      isGenerating: false,
      streamedText: "",
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
