import type { SessionConfig } from "../ExpoLocalLlm.types";
import {
  createLLMSession,
  generate,
  generateObject,
  getCapabilities,
  getModuleDiagnostics,
  SchemaInvalidError,
  StructuredOutputValidationError,
} from "../index";

const mockPlatform = { OS: "ios", Version: 26 };

jest.mock("react-native", () => ({ Platform: mockPlatform }));
jest.mock("expo-modules-core", () => {
  const respond = jest.fn();
  const release = jest.fn();
  const sessionConstructor = jest.fn();
  class MockNativeSession {
    respond = respond;
    release = release;
    constructor(config: SessionConfig) {
      sessionConstructor(config);
    }
  }
  const nativeModule = {
    getAvailability: jest.fn(() => "available"),
    downloadModel: jest.fn(),
    addListener: jest.fn(() => ({ remove: jest.fn() })),
    LLMSession: MockNativeSession,
    __respond: respond,
    __release: release,
    __sessionConstructor: sessionConstructor,
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
const mockRespond = mockNativeModule.__respond;
const mockRelease = mockNativeModule.__release;
const mockSessionConstructor = mockNativeModule.__sessionConstructor;

describe("native-present API", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPlatform.OS = "ios";
    mockPlatform.Version = 26;
  });

  it("reports backend and platform-specific capabilities", () => {
    expect(getModuleDiagnostics()).toEqual({
      available: true,
      reason: null,
      message: null,
      setupInstructions: [],
    });
    expect(getCapabilities()).toMatchObject({
      platform: "ios",
      backend: "appleFoundationModels",
      status: "available",
      text: true,
      streaming: true,
      tools: true,
      structuredOutput: true,
      structuredOutputMode: "constrained",
    });

    mockPlatform.OS = "android";
    expect(getCapabilities()).toMatchObject({
      platform: "android",
      backend: "geminiNano",
      text: true,
      streaming: true,
      tools: false,
      structuredOutput: false,
      structuredOutputMode: "unsupported",
    });

    mockPlatform.OS = "ios";
    mockPlatform.Version = 25;
    expect(getCapabilities()).toMatchObject({
      platform: "ios",
      backend: "appleFoundationModels",
      status: "unsupportedOS",
      text: false,
      streaming: false,
      tools: false,
      structuredOutput: false,
    });

    mockPlatform.OS = "web";
    expect(getCapabilities()).toEqual({
      platform: "unsupported",
      backend: null,
      status: "unsupportedPlatform",
      text: false,
      streaming: false,
      tools: false,
      structuredOutput: false,
      structuredOutputMode: "unsupported",
    });
  });

  it("keeps backend capabilities separate from current model readiness", () => {
    mockNativeModule.getAvailability.mockReturnValue("notReady");
    expect(getCapabilities()).toMatchObject({
      status: "available",
      backend: "appleFoundationModels",
      text: true,
    });
  });

  it("always releases one-shot sessions when native generation fails", async () => {
    mockRespond.mockRejectedValueOnce(new Error("native failure"));
    await expect(generate("hello")).rejects.toThrow("native failure");
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it("rejects explicit JSON mode without a schema before native construction", () => {
    expect(() => createLLMSession({ responseFormat: "json" })).toThrow(
      SchemaInvalidError
    );
    expect(mockSessionConstructor).not.toHaveBeenCalled();
  });

  it("rejects tools in the one-shot string helper", async () => {
    await expect(
      generate("hello", {
        tools: [
          {
            name: "lookup",
            description: "Lookup",
            parameters: {},
            handler: async () => "done",
          },
        ],
      })
    ).rejects.toThrow(/does not support tools/);
    expect(mockSessionConstructor).not.toHaveBeenCalled();
  });

  it("returns a schema-inferred validated object and releases the session", async () => {
    mockRespond.mockResolvedValueOnce(
      JSON.stringify({ kind: "a", rows: [{ value: 2 }] })
    );
    const result = await generateObject("extract", {
      schema: {
        kind: { type: "string", enum: ["a", "b"] },
        rows: {
          type: "array",
          items: {
            type: "object",
            properties: { value: { type: "integer" } },
          },
        },
      },
    });
    const kind: "a" | "b" = result.kind;
    expect(kind).toBe("a");
    expect(result.rows[0].value).toBe(2);
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it("rejects generated JSON that does not satisfy the schema", async () => {
    mockRespond.mockResolvedValueOnce(JSON.stringify({ count: 1.5 }));
    await expect(
      generateObject("extract", {
        schema: { count: { type: "integer" } },
      })
    ).rejects.toBeInstanceOf(StructuredOutputValidationError);
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid JSON and still releases the session", async () => {
    mockRespond.mockResolvedValueOnce("not json");
    await expect(
      generateObject("extract", {
        schema: { answer: { type: "string" } },
      })
    ).rejects.toBeInstanceOf(StructuredOutputValidationError);
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it("rejects structured output on Android before creating a session", async () => {
    mockPlatform.OS = "android";
    await expect(
      generateObject("extract", {
        schema: { answer: { type: "string" } },
      })
    ).rejects.toThrow(/not supported on android/);
    expect(mockSessionConstructor).not.toHaveBeenCalled();
  });
});
