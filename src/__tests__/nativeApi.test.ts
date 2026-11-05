import type { SessionConfig } from "../ExpoLocalLlm.types";
import {
  createLLMSession,
  generate,
  generateObject,
  getCapabilities,
  getLocalLLMErrorCode,
  getModuleDiagnostics,
  getModelReadiness,
  LocalLLMError,
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
    supportsImages: jest.fn(() => false),
    getImagePromptVersion: jest.fn(() => 1),
    getToolCallingVersion: jest.fn(() => 0),
    getModelReadiness: jest.fn(),
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
    mockNativeModule.getAvailability.mockReturnValue("available");
    mockNativeModule.supportsImages.mockReturnValue(false);
    mockNativeModule.getImagePromptVersion.mockReturnValue(1);
    mockPlatform.OS = "ios";
    mockPlatform.Version = 26;
    mockNativeModule.getToolCallingVersion.mockReturnValue(0);
  });

  it("gates tools and explicit model selection on rebuilt Android binaries", async () => {
    mockPlatform.OS = "android";
    const tool = {
      name: "lookup",
      description: "Lookup",
      parameters: {},
      handler: async () => "ok",
    };
    expect(() => createLLMSession({ tools: [tool] })).toThrow(/native tool/i);
    expect(() => createLLMSession({ androidModel: "previewFast" })).toThrow(
      /rebuild/i
    );
    await expect(getModelReadiness("previewFast")).rejects.toMatchObject({
      code: "ERR_UNSUPPORTED_REQUEST",
    });
    mockNativeModule.getToolCallingVersion.mockReturnValue(1);
    expect(getCapabilities()).toMatchObject({
      tools: true,
      structuredOutput: false,
      experimental: true,
    });
    createLLMSession({ androidModel: "previewFast", tools: [tool] });
    expect(mockSessionConstructor).toHaveBeenLastCalledWith({
      androidModel: "previewFast",
      tools: [{ name: "lookup", description: "Lookup", parameters: {} }],
    });
  });

  it("queries selected model readiness separately from integration support", async () => {
    mockPlatform.OS = "android";
    mockNativeModule.getToolCallingVersion.mockReturnValue(1);
    mockNativeModule.getModelReadiness.mockResolvedValueOnce({
      availability: "downloadRequired",
      tools: "available",
    });
    await expect(getModelReadiness("previewFast")).resolves.toEqual({
      availability: "downloadRequired",
      tools: "available",
    });
    expect(mockNativeModule.getModelReadiness).toHaveBeenLastCalledWith(
      "previewFast"
    );
    mockNativeModule.getModelReadiness.mockRejectedValueOnce(
      new Error("service unavailable")
    );
    await expect(getModelReadiness("default")).resolves.toEqual({
      availability: "unknown",
      tools: "unknown",
    });
    mockPlatform.OS = "ios";
    await expect(getModelReadiness("previewFast")).resolves.toEqual({
      availability: "available",
      tools: "available",
    });
    expect(mockNativeModule.getModelReadiness).toHaveBeenCalledTimes(2);
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
      images: "unsupported",
      tools: true,
      structuredOutput: true,
      structuredOutputMode: "constrained",
      experimental: false,
    });

    mockPlatform.OS = "android";
    expect(getCapabilities()).toMatchObject({
      platform: "android",
      backend: "geminiNano",
      text: true,
      streaming: true,
      images: "unknown",
      tools: false,
      structuredOutput: false,
      structuredOutputMode: "unsupported",
      experimental: true,
    });

    mockPlatform.OS = "ios";
    mockPlatform.Version = 25;
    expect(getCapabilities()).toMatchObject({
      platform: "ios",
      backend: "appleFoundationModels",
      status: "unsupportedOS",
      text: false,
      streaming: false,
      images: "unsupported",
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
      images: "unsupported",
      tools: false,
      structuredOutput: false,
      structuredOutputMode: "unsupported",
      experimental: false,
    });
  });

  it("reports no image support for an older Android bridge without the image protocol", () => {
    mockPlatform.OS = "android";
    const marker = mockNativeModule.getImagePromptVersion;
    delete mockNativeModule.getImagePromptVersion;
    try {
      expect(getCapabilities()).toMatchObject({ images: "unsupported" });
      expect(mockNativeModule.getAvailability).not.toHaveBeenCalled();
    } finally {
      mockNativeModule.getImagePromptVersion = marker;
    }
  });

  it("reports iOS image support only with a ready vision-capable native backend", () => {
    mockPlatform.Version = 27;
    mockNativeModule.supportsImages.mockReturnValue(true);
    expect(getCapabilities()).toMatchObject({ images: "supported" });

    mockNativeModule.supportsImages.mockReturnValue(false);
    expect(getCapabilities()).toMatchObject({ images: "unsupported" });

    mockPlatform.Version = 26;
    mockNativeModule.supportsImages.mockReturnValue(true);
    expect(getCapabilities()).toMatchObject({ images: "unsupported" });
  });

  it("keeps backend capabilities separate from current model readiness", () => {
    mockNativeModule.getAvailability.mockReturnValue("notReady");
    expect(getCapabilities()).toMatchObject({
      status: "available",
      backend: "appleFoundationModels",
      text: true,
      images: "unsupported",
    });

    mockPlatform.OS = "android";
    expect(getCapabilities()).toMatchObject({ images: "unsupported" });

    mockNativeModule.getAvailability.mockImplementation(() => {
      throw new Error("model service unavailable");
    });
    expect(getCapabilities()).toMatchObject({ images: "unsupported" });
  });

  it("always releases one-shot sessions when native generation fails", async () => {
    const prompt = {
      text: "Describe this image",
      images: [{ uri: "file:///tmp/photo.jpg", label: "photo" }],
    };
    mockRespond.mockRejectedValueOnce(new Error("native failure"));
    await expect(generate(prompt)).rejects.toThrow("native failure");
    expect(mockRespond).toHaveBeenCalledWith(prompt);
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it("forwards multiple image inputs unchanged and releases one-shot sessions", async () => {
    const prompt = {
      text: "Describe the foreground",
      images: [
        { uri: "file:///tmp/photo.jpg", label: "foreground" },
        { uri: "file:///tmp/other.jpg", label: "background" },
      ],
    };
    mockRespond.mockResolvedValueOnce("A building");

    await expect(generate(prompt)).resolves.toBe("A building");
    expect(mockRespond).toHaveBeenCalledWith(prompt);
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

  it("codes JavaScript-side failures like native ones", async () => {
    await expect(
      generate("hello", {
        tools: [
          {
            name: "lookup",
            description: "Lookup",
            parameters: {},
            handler: async () => "",
          },
        ],
      })
    ).rejects.toMatchObject({ code: "ERR_UNSUPPORTED_REQUEST" });

    mockPlatform.OS = "android";
    await expect(
      generateObject("hello", { schema: { name: { type: "string" } } })
    ).rejects.toMatchObject({ code: "ERR_RESPONSE_FORMAT_NOT_SUPPORTED" });

    expect(() => createLLMSession({ responseFormat: "json" })).toThrow(
      expect.objectContaining({ code: "ERR_SCHEMA_INVALID" })
    );
  });
});

describe("getLocalLLMErrorCode", () => {
  it("reads library codes from native and JavaScript errors", () => {
    expect(
      getLocalLLMErrorCode(
        Object.assign(new Error("x"), { code: "ERR_REFUSAL" })
      )
    ).toBe("ERR_REFUSAL");
    expect(
      getLocalLLMErrorCode(new LocalLLMError("ERR_SESSION_BUSY", "busy"))
    ).toBe("ERR_SESSION_BUSY");
    expect(
      getLocalLLMErrorCode(
        new LocalLLMError("ERR_IMAGE_NOT_SUPPORTED", "no vision model")
      )
    ).toBe("ERR_IMAGE_NOT_SUPPORTED");
    expect(getLocalLLMErrorCode(new StructuredOutputValidationError([]))).toBe(
      "ERR_STRUCTURED_OUTPUT_INVALID"
    );
  });

  it("returns null for other errors", () => {
    expect(getLocalLLMErrorCode(new Error("plain"))).toBeNull();
    expect(
      getLocalLLMErrorCode(
        Object.assign(new Error("x"), { code: "ERR_SOMETHING_ELSE" })
      )
    ).toBeNull();
  });
});
