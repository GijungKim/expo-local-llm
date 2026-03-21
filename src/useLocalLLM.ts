import { useEffect, useState, useCallback, useMemo } from "react";

import type {
  ModelAvailability,
  SessionConfig,
  TokenEvent,
  StreamCompleteEvent,
  StreamErrorEvent,
  DownloadProgress,
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

  // Stabilize options to avoid unnecessary session recreation
  const stableConfig = useMemo(
    () => options,
    [
      options.instructions,
      options.options?.temperature,
      options.options?.maxTokens,
      options.options?.topK,
    ]
  );

  const session = useMemo(() => {
    if (!ExpoLocalLlmModule) return null;
    try {
      return createLLMSession(stableConfig);
    } catch (e: any) {
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
    };
  }

  return {
    availability,
    session,
    isGenerating,
    streamedText,
    downloadProgress,
    error,
    respond: session && availability === "available" ? respond : undefined,
    streamResponse:
      session && availability === "available" ? streamResponse : undefined,
    cancelStream:
      session && availability === "available" ? cancelStream : undefined,
    downloadModel,
  };
}
