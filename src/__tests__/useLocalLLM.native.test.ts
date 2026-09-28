import React, { StrictMode } from "react";
import TestRenderer, { act } from "react-test-renderer";

import type { SessionConfig, ToolArguments } from "../ExpoLocalLlm.types";
import { useLocalLLM } from "../useLocalLLM";

type MockStreamEvent = {
  token?: string;
  accumulated?: string;
  json?: string;
  complete?: boolean;
  text?: string;
  error?: string;
  callId?: string;
  toolName?: string;
  arguments?: ToolArguments;
};

jest.mock("react-native", () => ({
  Platform: { OS: "ios" },
  AppState: { addEventListener: jest.fn(() => ({ remove: jest.fn() })) },
}));
jest.mock(
  "react-native-web/dist/exports/AppState",
  () => ({
    __esModule: true,
    default: { addEventListener: jest.fn(() => ({ remove: jest.fn() })) },
  }),
  { virtual: true }
);
jest.mock("expo-modules-core", () => {
  const release = jest.fn();
  const sessionConstructor = jest.fn();
  const instances: MockNativeSession[] = [];
  class MockNativeSession {
    listeners = new Map<string, (mockPayload: MockStreamEvent) => void>();
    respond = jest.fn();
    streamResponse = jest.fn();
    cancelStream = jest.fn();
    reset = jest.fn();
    resolveToolCall = jest.fn();
    rejectToolCall = jest.fn();
    addListener = jest.fn(
      (name: string, listener: (mockPayload: MockStreamEvent) => void) => {
        this.listeners.set(name, listener);
        return { remove: jest.fn(() => this.listeners.delete(name)) };
      }
    );
    release = release;
    constructor(config: SessionConfig) {
      sessionConstructor(config);
      instances.push(this);
    }
    emit(name: string, mockEvent: MockStreamEvent) {
      this.listeners.get(name)?.(mockEvent);
    }
  }
  const nativeModule = {
    getAvailability: jest.fn(() => "available"),
    downloadModel: jest.fn(),
    addListener: jest.fn(() => ({ remove: jest.fn() })),
    LLMSession: MockNativeSession,
    __release: release,
    __sessionConstructor: sessionConstructor,
    __instances: instances,
  };
  return {
    requireNativeModule: jest.fn(() => nativeModule),
    NativeModule: class {},
    SharedObject: class {},
    UnavailabilityError: class UnavailabilityError extends Error {},
    __nativeModule: nativeModule,
  };
});

const mockNativeModule = require("expo-modules-core").__nativeModule;
const mockRelease = mockNativeModule.__release;
const mockSessionConstructor = mockNativeModule.__sessionConstructor;
const mockInstances = mockNativeModule.__instances;

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function Consumer() {
  useLocalLLM({ instructions: "Be concise" });
  return null;
}

function AvailabilityConsumer({ onValue }: { onValue(value: string): void }) {
  onValue(useLocalLLM().availability);
  return null;
}

type HookResult = ReturnType<typeof useLocalLLM>;

function ResultConsumer({
  instructions,
  onValue,
}: {
  instructions: string;
  onValue(value: HookResult): void;
}) {
  onValue(useLocalLLM({ instructions }));
  return null;
}

function ToolConsumer({
  instructions,
  handler,
  onValue,
}: {
  instructions: string;
  handler(): Promise<string>;
  onValue(value: HookResult): void;
}) {
  onValue(
    useLocalLLM({
      instructions,
      tools: [
        {
          name: "lookup",
          description: "Lookup a value",
          parameters: {},
          handler,
        },
      ],
    })
  );
  return null;
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("useLocalLLM native session lifecycle", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockInstances.splice(0);
    mockNativeModule.getAvailability.mockReturnValue("available");
  });

  it("creates sessions after commit and releases every StrictMode instance", async () => {
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        React.createElement(StrictMode, null, React.createElement(Consumer))
      );
    });

    expect(mockSessionConstructor).toHaveBeenCalled();
    expect(mockRelease.mock.calls.length).toBeLessThan(
      mockSessionConstructor.mock.calls.length
    );

    await act(async () => {
      renderer.unmount();
    });
    expect(mockRelease).toHaveBeenCalledTimes(
      mockSessionConstructor.mock.calls.length
    );
  });

  it("subscribes before refreshing and rechecks availability on foreground", async () => {
    let availability = "";
    mockNativeModule.getAvailability.mockReturnValue("notReady");
    const AppState = jest.requireMock(
      "react-native-web/dist/exports/AppState"
    ).default;
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        React.createElement(AvailabilityConsumer, {
          onValue: (value) => (availability = value),
        })
      );
    });

    const availabilityListenerOrder =
      mockNativeModule.addListener.mock.invocationCallOrder[1];
    const refreshOrder =
      mockNativeModule.getAvailability.mock.invocationCallOrder.at(-1);
    expect(availabilityListenerOrder).toBeLessThan(refreshOrder);

    mockNativeModule.getAvailability.mockReturnValue("available");
    const foreground = AppState.addEventListener.mock.calls.at(-1)[1];
    await act(async () => foreground("active"));
    expect(availability).toBe("available");

    mockNativeModule.getAvailability.mockImplementation(() => {
      throw new Error("refresh failed");
    });
    await act(async () => foreground("active"));
    expect(availability).toBe("unknown");

    await act(async () => renderer.unmount());
  });

  it("rejects overlapping respond calls without ending the active request", async () => {
    let result: HookResult | null = null;
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        React.createElement(ResultConsumer, {
          instructions: "first",
          onValue: (value) => (result = value),
        })
      );
    });
    const first = deferred<string>();
    mockInstances.at(-1).respond.mockReturnValueOnce(first.promise);

    let pending!: Promise<string>;
    await act(async () => {
      pending = result!.respond!("first");
      await Promise.resolve();
    });
    expect(result!.isGenerating).toBe(true);
    await expect(result!.respond!("second")).rejects.toThrow(
      /already in progress/
    );
    expect(result!.isGenerating).toBe(true);
    expect(result!.error).toBeNull();

    await act(async () => {
      first.resolve("done");
      await pending;
    });
    expect(result!.isGenerating).toBe(false);
    await act(async () => renderer.unmount());
  });

  it("does not clear an active stream when a second stream is rejected", async () => {
    let result: HookResult | null = null;
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        React.createElement(ResultConsumer, {
          instructions: "stream",
          onValue: (value) => (result = value),
        })
      );
    });
    const stream = deferred<string>();
    const nativeSession = mockInstances.at(-1);
    nativeSession.streamResponse.mockReturnValueOnce(stream.promise);
    let pending!: Promise<string>;
    await act(async () => {
      pending = result!.streamResponse!("first");
      const requestId = nativeSession.streamResponse.mock.calls.at(-1)[1];
      nativeSession.emit("token", {
        requestId,
        token: "one",
        accumulated: "one",
      });
      await Promise.resolve();
    });
    expect(result!.streamedText).toBe("one");
    await expect(result!.streamResponse!("second")).rejects.toThrow(
      /already in progress/
    );
    expect(result!.streamedText).toBe("one");
    expect(result!.isGenerating).toBe(true);

    await act(async () => {
      stream.resolve("one");
      await pending;
    });
    await act(async () => renderer.unmount());
  });

  it("keeps the stream busy when completion event arrives before the promise", async () => {
    let result: HookResult | null = null;
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        React.createElement(ResultConsumer, {
          instructions: "event first",
          onValue: (value) => (result = value),
        })
      );
    });
    const stream = deferred<string>();
    const nativeSession = mockInstances.at(-1);
    nativeSession.streamResponse.mockReturnValueOnce(stream.promise);
    let pending!: Promise<string>;
    await act(async () => {
      pending = result!.streamResponse!("first");
      const requestId = nativeSession.streamResponse.mock.calls.at(-1)[1];
      nativeSession.emit("streamComplete", {
        requestId,
        text: "event final",
      });
      await Promise.resolve();
    });
    expect(result!.streamedText).toBe("event final");
    expect(result!.isGenerating).toBe(true);

    await act(async () => {
      stream.resolve("promise final");
      await pending;
    });
    expect(result!.streamedText).toBe("promise final");
    expect(result!.isGenerating).toBe(false);
    await act(async () => renderer.unmount());
  });

  it("publishes the awaited stream result when the promise precedes its event", async () => {
    let result: HookResult | null = null;
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        React.createElement(ResultConsumer, {
          instructions: "promise first",
          onValue: (value) => (result = value),
        })
      );
    });
    const stream = deferred<string>();
    const nativeSession = mockInstances.at(-1);
    nativeSession.streamResponse.mockReturnValueOnce(stream.promise);
    let pending!: Promise<string>;
    let requestId = "";
    await act(async () => {
      pending = result!.streamResponse!("first");
      requestId = nativeSession.streamResponse.mock.calls.at(-1)[1];
      stream.resolve("promise final");
      await pending;
    });
    expect(result!.streamedText).toBe("promise final");
    expect(result!.isGenerating).toBe(false);

    await act(async () => {
      nativeSession.emit("streamComplete", {
        requestId,
        text: "late event",
      });
    });
    expect(result!.streamedText).toBe("promise final");
    await act(async () => renderer.unmount());
  });

  it("does not let delayed cancellation stop generation started after reset", async () => {
    let result: HookResult | null = null;
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        React.createElement(ResultConsumer, {
          instructions: "cancel race",
          onValue: (value) => (result = value),
        })
      );
    });
    const oldStream = deferred<string>();
    const cancellation = deferred<void>();
    const newResponse = deferred<string>();
    const nativeSession = mockInstances.at(-1);
    nativeSession.streamResponse.mockReturnValueOnce(oldStream.promise);
    nativeSession.cancelStream.mockReturnValueOnce(cancellation.promise);
    nativeSession.respond.mockReturnValueOnce(newResponse.promise);

    let oldPending!: Promise<string>;
    await act(async () => {
      oldPending = result!.streamResponse!("old");
      await Promise.resolve();
    });
    const cancelPending = result!.cancelStream!();
    await act(async () => result!.reset!());
    let newPending!: Promise<string>;
    await act(async () => {
      newPending = result!.respond!("new");
      await Promise.resolve();
    });
    const availabilityChange = [...mockNativeModule.addListener.mock.calls]
      .reverse()
      .find(([name]) => name === "availabilityChange")?.[1];
    await act(async () => availabilityChange({ availability: "notReady" }));
    expect(result!.availability).toBe("notReady");
    expect(result!.cancelStream).toBeDefined();
    await act(async () => {
      cancellation.resolve();
      await cancelPending;
    });
    expect(result!.isGenerating).toBe(true);

    await act(async () => {
      newResponse.resolve("new final");
      await newPending;
      oldStream.resolve("old final");
      await oldPending;
    });
    expect(result!.isGenerating).toBe(false);
    await act(async () => renderer.unmount());
  });

  it("ignores stale request rejection after reset", async () => {
    let result: HookResult | null = null;
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        React.createElement(ResultConsumer, {
          instructions: "reset",
          onValue: (value) => (result = value),
        })
      );
    });
    const first = deferred<string>();
    mockInstances.at(-1).respond.mockReturnValueOnce(first.promise);
    let pending!: Promise<string>;
    await act(async () => {
      pending = result!.respond!("first");
      await Promise.resolve();
    });
    await act(async () => result!.reset!());
    await act(async () => {
      first.reject(new Error("stale failure"));
      await expect(pending).rejects.toThrow("stale failure");
    });
    expect(result!.error).toBeNull();
    expect(result!.isGenerating).toBe(false);
    await act(async () => renderer.unmount());
  });

  it("rejects queued events from an old request after reset", async () => {
    let result: HookResult | null = null;
    let renderer: TestRenderer.ReactTestRenderer;
    const handler = jest.fn(async () => "handled");
    await act(async () => {
      renderer = TestRenderer.create(
        React.createElement(ToolConsumer, {
          instructions: "queued events",
          handler,
          onValue: (value) => (result = value),
        })
      );
    });
    const oldStream = deferred<string>();
    const newStream = deferred<string>();
    const nativeSession = mockInstances.at(-1);
    nativeSession.streamResponse
      .mockReturnValueOnce(oldStream.promise)
      .mockReturnValueOnce(newStream.promise);

    let oldPending!: Promise<string>;
    await act(async () => {
      oldPending = result!.streamResponse!("old");
      await Promise.resolve();
    });
    const oldRequestId = nativeSession.streamResponse.mock.calls.at(-1)[1];
    await act(async () => result!.reset!());

    let newPending!: Promise<string>;
    await act(async () => {
      newPending = result!.streamResponse!("new");
      await Promise.resolve();
    });
    const newRequestId = nativeSession.streamResponse.mock.calls.at(-1)[1];
    expect(newRequestId).not.toBe(oldRequestId);

    await act(async () => {
      nativeSession.emit("token", {
        requestId: oldRequestId,
        token: "old",
        accumulated: "old token",
      });
      nativeSession.emit("token", {
        token: "missing-id",
        accumulated: "missing id token",
      });
      nativeSession.emit("partial", {
        requestId: oldRequestId,
        json: '{"old":true}',
        complete: false,
      });
      nativeSession.emit("streamComplete", {
        requestId: oldRequestId,
        text: "old complete",
      });
      nativeSession.emit("streamError", {
        requestId: oldRequestId,
        error: "old error",
      });
      nativeSession.emit("toolCall", {
        requestId: oldRequestId,
        callId: "old-tool",
        toolName: "lookup",
        arguments: {},
      });
    });
    expect(result!.streamedText).toBe("");
    expect(result!.streamedJSON).toBe("");
    expect(result!.error).toBeNull();
    expect(result!.isGenerating).toBe(true);
    expect(result!.activeToolCalls).toEqual([]);
    expect(handler).not.toHaveBeenCalled();

    await act(async () => {
      nativeSession.emit("token", {
        requestId: newRequestId,
        token: "new",
        accumulated: "new token",
      });
      nativeSession.emit("toolCall", {
        requestId: newRequestId,
        callId: "new-tool",
        toolName: "lookup",
        arguments: {},
      });
      await Promise.resolve();
    });
    expect(result!.streamedText).toBe("new token");
    expect(handler).toHaveBeenCalledTimes(1);
    expect(nativeSession.resolveToolCall).toHaveBeenCalledWith(
      "new-tool",
      "handled"
    );

    await act(async () => {
      newStream.resolve("new final");
      await newPending;
      oldStream.resolve("old final");
      await oldPending;
    });
    expect(result!.streamedText).toBe("new final");
    await act(async () => renderer.unmount());
  });

  it("ignores stale settlement after replacing the session", async () => {
    let result: HookResult | null = null;
    let renderer: TestRenderer.ReactTestRenderer;
    const render = (instructions: string) =>
      React.createElement(ResultConsumer, {
        instructions,
        onValue: (value) => (result = value),
      });
    await act(async () => {
      renderer = TestRenderer.create(render("old"));
    });
    const oldRequest = deferred<string>();
    mockInstances.at(-1).respond.mockReturnValueOnce(oldRequest.promise);
    let pending!: Promise<string>;
    await act(async () => {
      pending = result!.respond!("old");
      await Promise.resolve();
    });
    await act(async () => renderer.update(render("new")));
    await act(async () => {
      oldRequest.reject(new Error("old session failure"));
      await expect(pending).rejects.toThrow("old session failure");
    });
    expect(result!.error).toBeNull();
    expect(result!.isGenerating).toBe(false);
    expect(result!.session).toBe(mockInstances.at(-1));
    await act(async () => renderer.unmount());
  });

  it("drops pending tool callbacks and clears tool state on replacement", async () => {
    let result: HookResult | null = null;
    let renderer: TestRenderer.ReactTestRenderer;
    const toolResult = deferred<string>();
    const render = (instructions: string) =>
      React.createElement(ToolConsumer, {
        instructions,
        handler: () => toolResult.promise,
        onValue: (value) => (result = value),
      });
    await act(async () => {
      renderer = TestRenderer.create(render("old"));
    });
    const oldSession = mockInstances.at(-1);
    const response = deferred<string>();
    oldSession.respond.mockReturnValueOnce(response.promise);
    let pending!: Promise<string>;
    await act(async () => {
      pending = result!.respond!("old");
      await Promise.resolve();
    });
    const requestId = oldSession.respond.mock.calls.at(-1)[1];
    await act(async () => {
      oldSession.emit("toolCall", {
        requestId,
        callId: "old-call",
        toolName: "lookup",
        arguments: {},
      });
    });
    expect(result!.activeToolCalls).toEqual([
      { callId: "old-call", toolName: "lookup" },
    ]);

    await act(async () => renderer.update(render("new")));
    expect(result!.activeToolCalls).toEqual([]);
    await act(async () => {
      toolResult.resolve("stale result");
      await toolResult.promise;
      response.resolve("stale response");
      await pending;
    });
    expect(oldSession.resolveToolCall).not.toHaveBeenCalled();
    expect(oldSession.rejectToolCall).not.toHaveBeenCalled();
    await act(async () => renderer.unmount());
  });

  it("clears timed-out tool state without letting its stale handler alter a new request", async () => {
    let result: HookResult | null = null;
    let renderer: TestRenderer.ReactTestRenderer;
    const oldTool = deferred<string>();
    const newTool = deferred<string>();
    const handler = jest
      .fn()
      .mockReturnValueOnce(oldTool.promise)
      .mockReturnValueOnce(newTool.promise);
    await act(async () => {
      renderer = TestRenderer.create(
        React.createElement(ToolConsumer, {
          instructions: "tool timeout",
          handler,
          onValue: (value) => (result = value),
        })
      );
    });
    const nativeSession = mockInstances.at(-1);
    const oldResponse = deferred<string>();
    nativeSession.respond.mockReturnValueOnce(oldResponse.promise);
    let oldPending!: Promise<string>;
    await act(async () => {
      oldPending = result!.respond!("old");
      await Promise.resolve();
    });
    const oldRequestId = nativeSession.respond.mock.calls.at(-1)[1];
    await act(async () => {
      nativeSession.emit("toolCall", {
        requestId: oldRequestId,
        callId: "old-tool",
        toolName: "lookup",
        arguments: {},
      });
    });
    expect(result!.activeToolCalls).toHaveLength(1);

    await act(async () => {
      oldResponse.reject(new Error("tool timed out"));
      await expect(oldPending).rejects.toThrow("tool timed out");
    });
    expect(result!.activeToolCalls).toEqual([]);

    const newResponse = deferred<string>();
    nativeSession.respond.mockReturnValueOnce(newResponse.promise);
    let newPending!: Promise<string>;
    await act(async () => {
      newPending = result!.respond!("new");
      await Promise.resolve();
    });
    const newRequestId = nativeSession.respond.mock.calls.at(-1)[1];
    await act(async () => {
      nativeSession.emit("toolCall", {
        requestId: newRequestId,
        callId: "new-tool",
        toolName: "lookup",
        arguments: {},
      });
    });
    expect(result!.activeToolCalls).toEqual([
      { callId: "new-tool", toolName: "lookup" },
    ]);

    await act(async () => {
      oldTool.resolve("old result");
      await oldTool.promise;
    });
    expect(result!.activeToolCalls).toEqual([
      { callId: "new-tool", toolName: "lookup" },
    ]);
    expect(nativeSession.resolveToolCall).not.toHaveBeenCalledWith(
      "old-tool",
      "old result"
    );

    await act(async () => {
      newTool.resolve("new result");
      await newTool.promise;
    });
    expect(result!.activeToolCalls).toEqual([]);
    expect(nativeSession.resolveToolCall).toHaveBeenCalledWith(
      "new-tool",
      "new result"
    );

    await act(async () => {
      newResponse.resolve("done");
      await newPending;
      renderer.unmount();
    });
  });
});
