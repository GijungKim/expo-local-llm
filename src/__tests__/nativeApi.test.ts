import type {
  GenerateObjectConfig,
  Schema,
  SchemaField,
  SessionConfig,
} from "../ExpoLocalLlm.types";
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
  const sessions: MockNativeSession[] = [];
  class MockNativeSession {
    respond = respond;
    release = jest.fn(() => release());
    constructor(config: SessionConfig) {
      sessionConstructor(config);
      sessions.push(this);
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
    __sessions: sessions,
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
    mockRespond.mockReset();
    mockRelease.mockReset();
    mockSessionConstructor.mockReset();
    mockNativeModule.__sessions.length = 0;
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
      objectGenerationMode: "validated",
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
      objectGenerationMode: "constrained",
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
      objectGenerationMode: "validated",
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
      objectGenerationMode: "unsupported",
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
      objectGenerationMode: "unsupported",
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
    expect(result.rows[0]?.value).toBe(2);
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

  it.each([undefined, "auto"] as const)(
    "automatically validates and repairs structured output on an Android bridge with mode %s",
    async (mode) => {
      mockPlatform.OS = "android";
      mockRespond
        .mockResolvedValueOnce("not json")
        .mockResolvedValueOnce('{"answer":"yes"}');
      const result = await generateObject("extract", {
        ...(mode && { mode }),
        schema: { answer: { type: "string" } },
      });
      expect(result).toEqual({ answer: "yes" });
      expect(mockSessionConstructor).toHaveBeenCalledTimes(2);
      expect(mockRelease).toHaveBeenCalledTimes(2);
      expect(mockSessionConstructor).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ responseFormat: "text" })
      );
      expect(mockRespond.mock.calls[1][0].text).toContain(
        "The previous response failed"
      );
    }
  );

  it("does not repair or reroute an Android provider failure in automatic mode", async () => {
    mockPlatform.OS = "android";
    const error = new LocalLLMError(
      "ERR_MODEL_UNAVAILABLE",
      "model unavailable"
    );
    mockRespond.mockRejectedValueOnce(error);
    await expect(
      generateObject("extract", {
        schema: { answer: { type: "string" } },
      })
    ).rejects.toBe(error);
    expect(mockSessionConstructor).toHaveBeenCalledTimes(1);
    expect(mockRespond).toHaveBeenCalledTimes(1);
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it("rejects automatic output on an unsupported OS before construction", async () => {
    mockPlatform.Version = 25;
    await expect(
      generateObject("extract", {
        schema: { answer: { type: "string" } },
      })
    ).rejects.toMatchObject({ code: "ERR_RESPONSE_FORMAT_NOT_SUPPORTED" });
    expect(mockSessionConstructor).not.toHaveBeenCalled();
  });

  describe("explicit validated output", () => {
    const schema = {
      kind: { type: "string", enum: ["a", "b"] },
      rows: {
        type: "array",
        items: { type: "object", properties: { value: { type: "integer" } } },
      },
    } as const satisfies Schema;
    const valid = { kind: "a", rows: [{ value: 2 }] };
    const output = JSON.stringify(valid);
    const config = { mode: "validated", schema } as const;

    function pendingResponse() {
      let resolve!: (value: string) => void;
      let reject!: (error: Error) => void;
      const promise = new Promise<string>((accept, decline) => {
        resolve = accept;
        reject = decline;
      });
      return { promise, resolve, reject };
    }

    afterEach(() => {
      for (const session of mockNativeModule.__sessions) {
        expect(session.release).toHaveBeenCalledTimes(1);
      }
    });

    it.each(["ios", "android"])(
      "validates nested fields and enums on %s through TEXT",
      async (platform) => {
        mockPlatform.OS = platform;
        mockRespond.mockResolvedValueOnce(output);
        const result = await generateObject("extract", config);
        const kind: "a" | "b" = result.kind;
        expect(kind).toBe("a");
        expect(result).toEqual(valid);
        expect(mockSessionConstructor).toHaveBeenCalledTimes(1);
        const nativeConfig = mockSessionConstructor.mock.calls[0][0];
        expect(nativeConfig.responseFormat).toBe("text");
        for (const option of [
          "schema",
          "mode",
          "repairAttempts",
          "signal",
          "includeSchemaInPrompt",
        ]) {
          expect(nativeConfig).not.toHaveProperty(option);
        }
        expect(nativeConfig.tools).toBeUndefined();
        const request = mockRespond.mock.calls[0][0];
        expect(request.text).toContain("extract");
        expect(request.text).toContain(JSON.stringify(schema));
        expect(request.text).toContain("bare JSON");
      }
    );

    it.each([
      "not json",
      '```json\n{"kind":"a","rows":[]}\n```',
      'Here is {"kind":"a","rows":[]}',
      '{"kind":"a","rows":[]} trailing',
      '{"kind":"c","rows":[]}',
      '{"kind":"a"}',
      '{"kind":"a","rows":[],"extra":true}',
      '{"kind":"a","rows":[{}]}',
      '{"kind":"a","rows":[{"value":"2"}]}',
      '{"kind":"a","rows":[{"value":2,"extra":0}]}',
      '{"kind":"a","rows":[{"value":1.5}]}',
      '{"kind":"a","rows":[null]}',
      "[]",
      "null",
    ])("repairs only strict JSON/schema failures: %s", async (invalid) => {
      mockRespond.mockResolvedValueOnce(invalid).mockResolvedValueOnce(output);
      await expect(generateObject("extract", config)).resolves.toEqual(valid);
      expect(mockSessionConstructor).toHaveBeenCalledTimes(2);
      const repair = mockRespond.mock.calls[1][0].text;
      expect(repair).toContain("extract");
      expect(repair).toContain(JSON.stringify(schema));
      expect(repair).toContain(invalid);
      expect(repair).toContain("Validation errors:");
    });

    it.each([0, 1] as const)(
      "bounds additional repair attempts to %s",
      async (repairAttempts) => {
        mockRespond.mockResolvedValue("{}");
        await expect(
          generateObject("extract", { ...config, repairAttempts })
        ).rejects.toBeInstanceOf(StructuredOutputValidationError);
        expect(mockRespond).toHaveBeenCalledTimes(repairAttempts + 1);
      }
    );

    it.each([
      "ERR_REFUSAL",
      "ERR_GUARDRAIL_VIOLATION",
      "ERR_RATE_LIMITED",
      "ERR_MODEL_UNAVAILABLE",
      "ERR_CONTEXT_WINDOW_EXCEEDED",
      "ERR_GENERATION_FAILED",
      "ERR_TIMEOUT",
      "ERR_DECODING_FAILED",
    ])("propagates %s without repair", async (code) => {
      const error = Object.assign(new Error("native query failed"), { code });
      mockRespond.mockRejectedValueOnce(error);
      await expect(generateObject("extract", config)).rejects.toBe(error);
      expect(mockRespond).toHaveBeenCalledTimes(1);
    });

    it("propagates a failed repair query without a third attempt", async () => {
      const error = new Error("repair query failed");
      mockRespond.mockResolvedValueOnce("{}").mockRejectedValueOnce(error);
      await expect(generateObject("extract", config)).rejects.toBe(error);
      expect(mockRespond).toHaveBeenCalledTimes(2);
    });

    it("keeps explicit constrained mode native and never falls back", async () => {
      const error = new LocalLLMError(
        "ERR_DECODING_FAILED",
        "native decoding failed"
      );
      mockRespond.mockRejectedValueOnce(error);
      await expect(
        generateObject("extract", { mode: "constrained", schema })
      ).rejects.toBe(error);
      expect(mockSessionConstructor).toHaveBeenCalledTimes(1);
      expect(mockSessionConstructor).toHaveBeenCalledWith({
        schema,
        responseFormat: "json",
        tools: undefined,
      });
      expect(mockRespond).toHaveBeenCalledWith("extract");
    });

    it("keeps automatic iOS mode native and never falls back", async () => {
      const error = new LocalLLMError(
        "ERR_DECODING_FAILED",
        "native decoding failed"
      );
      mockRespond.mockRejectedValueOnce(error);
      await expect(generateObject("extract", { schema })).rejects.toBe(error);
      expect(mockSessionConstructor).toHaveBeenCalledTimes(1);
      expect(mockSessionConstructor).toHaveBeenCalledWith({
        schema,
        responseFormat: "json",
        tools: undefined,
      });
      expect(mockRespond).toHaveBeenCalledTimes(1);
    });

    it("does not reinterpret a native rejection as a local validation failure", async () => {
      const error = new StructuredOutputValidationError([]);
      mockRespond.mockRejectedValueOnce(error);
      await expect(generateObject("extract", config)).rejects.toBe(error);
      expect(mockRespond).toHaveBeenCalledTimes(1);
    });

    it("propagates synchronous construction and respond failures", async () => {
      const error = new Error("native construction failed");
      mockSessionConstructor.mockImplementationOnce(() => {
        throw error;
      });
      await expect(generateObject("extract", config)).rejects.toBe(error);
      expect(mockRespond).not.toHaveBeenCalled();
      expect(mockRelease).not.toHaveBeenCalled();
      mockRespond.mockImplementationOnce(() => {
        throw error;
      });
      await expect(generateObject("extract", config)).rejects.toBe(error);
      expect(mockRespond).toHaveBeenCalledTimes(1);
    });

    it.each(["web", "windows", "old-ios"])(
      "rejects unsupported integration %s before construction",
      async (platform) => {
        mockPlatform.OS = platform === "old-ios" ? "ios" : platform;
        mockPlatform.Version = 25;
        await expect(generateObject("extract", config)).rejects.toMatchObject({
          code: "ERR_RESPONSE_FORMAT_NOT_SUPPORTED",
        });
        expect(mockSessionConstructor).not.toHaveBeenCalled();
      }
    );

    it("reports an unavailable native module in validated mode", async () => {
      let result: Promise<unknown> | undefined;
      jest.isolateModules(() => {
        require("expo-modules-core").requireNativeModule.mockImplementationOnce(
          () => {
            throw new Error("missing module");
          }
        );
        result = require("../index").generateObject("extract", config);
      });
      await expect(result).rejects.toMatchObject({
        name: "NativeModuleUnavailableError",
      });
      expect(mockSessionConstructor).not.toHaveBeenCalled();
    });

    it.each([
      { mode: "unknown" },
      { mode: null },
      { repairAttempts: -1 },
      { repairAttempts: 2 },
      { repairAttempts: 0.5 },
      { repairAttempts: "1" },
      { repairAttempts: null },
      { signal: {} },
      { signal: null },
      { mode: "constrained", repairAttempts: 0 },
      { mode: "constrained", signal: new AbortController().signal },
      { mode: "auto", repairAttempts: 0 },
      { mode: "auto", signal: new AbortController().signal },
      { tools: [] },
      { mode: "constrained", tools: [] },
      { tools: null },
      { tools: [{ name: "lookup", handler: () => "no" }] },
    ])(
      "rejects invalid runtime options before construction: %j",
      async (override) => {
        // SAFETY: deliberately bypass the static API to exercise runtime JS callers.
        const invalid = { ...config, ...override } as GenerateObjectConfig<
          typeof schema
        >;
        await expect(generateObject("extract", invalid)).rejects.toMatchObject({
          code: "ERR_UNSUPPORTED_REQUEST",
        });
        expect(mockSessionConstructor).not.toHaveBeenCalled();
      }
    );

    it.each([
      {},
      { value: { type: "bad" } },
      { value: { type: "array" } },
      { value: { type: "string", enum: [] } },
      { value: null },
      [{ type: "string" }],
      { value: { type: "object", properties: [{ type: "string" }] } },
      { value: Object.assign([], { type: "string" }) },
      { value: { type: "string", enum: "a" } },
    ])("validates runtime schemas before construction: %j", async (invalid) => {
      // SAFETY: deliberately malformed JS input, tested through the public boundary.
      const invalidSchema = invalid as Schema;
      await expect(
        generateObject("extract", { ...config, schema: invalidSchema })
      ).rejects.toMatchObject({ code: "ERR_SCHEMA_INVALID" });
      expect(mockSessionConstructor).not.toHaveBeenCalled();
    });

    it("copies enum values without invoking caller-owned slice", async () => {
      const values = ["a"];
      values.slice = jest.fn(() => values);
      const pending = pendingResponse();
      mockRespond.mockReturnValueOnce(pending.promise);
      const result = generateObject("extract", {
        mode: "validated",
        repairAttempts: 0,
        schema: { value: { type: "string", enum: values } },
      });
      expect(mockRespond.mock.calls[0][0].text).toContain('"enum":["a"]');
      values[0] = "b";
      pending.resolve('{"value":"b"}');
      await expect(result).rejects.toBeInstanceOf(
        StructuredOutputValidationError
      );
      expect(values.slice).not.toHaveBeenCalled();
    });

    it("copies enum subclasses into ordinary arrays without species or serialization hooks", async () => {
      class EnumValues extends Array<string> {
        static get [Symbol.species](): never {
          throw new Error("Must not invoke enum species");
        }
        toJSON() {
          return ["b"];
        }
      }
      const values = new EnumValues("a");
      const pending = pendingResponse();
      mockRespond.mockReturnValueOnce(pending.promise);
      const result = generateObject("extract", {
        mode: "validated",
        schema: { value: { type: "string", enum: values } },
      });
      expect(mockRespond.mock.calls[0][0].text).toContain('"enum":["a"]');
      values[0] = "b";
      pending.resolve('{"value":"a"}');
      await expect(result).resolves.toEqual({ value: "a" });
      expect(mockRespond).toHaveBeenCalledTimes(1);
    });

    it("rejects cyclic, deep, large and unserializable schemas before construction", async () => {
      const cyclic: Schema = {};
      cyclic.self = { type: "object", properties: cyclic };
      let deep: SchemaField = { type: "string" };
      for (let i = 0; i < 17; i++) deep = { type: "array", items: deep };
      const unserializable = {
        answer: { type: "string" },
        toJSON() {
          throw new Error("cannot serialize");
        },
      };
      for (const invalid of [
        cyclic,
        { deep },
        { value: { type: "string", description: "x".repeat(16_384) } },
        unserializable,
        {
          value: {
            type: "string",
            toJSON() {
              return { type: "number" };
            },
          },
        },
      ]) {
        // SAFETY: intentional malformed runtime input; the helper must reject it.
        await expect(
          generateObject("extract", { ...config, schema: invalid as Schema })
        ).rejects.toBeInstanceOf(SchemaInvalidError);
      }
      expect(mockSessionConstructor).not.toHaveBeenCalled();
    });

    it("snapshots original task, schema, images, model and options across repair", async () => {
      mockPlatform.OS = "android";
      mockNativeModule.getToolCallingVersion.mockReturnValue(1);
      const pending = pendingResponse();
      mockRespond
        .mockReturnValueOnce(pending.promise)
        .mockResolvedValueOnce(output);
      const photo = { uri: "file:///original.jpg", label: "photo" };
      const prompt = { text: "original task", images: [photo] };
      const mutableSchema: Schema = {
        ...schema,
        kind: { type: "string", enum: ["a", "b"] },
      };
      const mutableConfig = {
        mode: "validated",
        schema: mutableSchema,
        androidModel: "previewFast",
        instructions: "original instructions",
        options: { temperature: 0.2, maxTokens: 1024, topK: 4 },
        responseFormat: "json",
        includeSchemaInPrompt: false,
      } as const;
      const result = generateObject(prompt, mutableConfig);
      prompt.text = "mutated task";
      photo.uri = "file:///mutated.jpg";
      photo.label = "mutated label";
      prompt.images.push({ uri: "file:///new.jpg", label: "new" });
      mutableSchema.kind = { type: "boolean" };
      mutableSchema.rows = { type: "number" };
      Object.assign(mutableConfig, {
        instructions: "mutated instructions",
        androidModel: "default",
        repairAttempts: 0,
      });
      Object.assign(mutableConfig.options, {
        temperature: 1,
        maxTokens: 1,
        topK: 1,
      });
      pending.resolve("not json");
      await expect(result).resolves.toEqual(valid);
      expect(mockRespond).toHaveBeenCalledTimes(2);
      for (const [request] of mockRespond.mock.calls) {
        expect(request.text).toContain("original task");
        expect(request.text).toContain(JSON.stringify(schema));
        expect(request.text).not.toContain("mutated");
        expect(request.images).toEqual([
          { uri: "file:///original.jpg", label: "photo" },
        ]);
      }
      for (const [nativeConfig] of mockSessionConstructor.mock.calls) {
        expect(nativeConfig).toEqual({
          androidModel: "previewFast",
          instructions: "original instructions",
          options: { temperature: 0.2, maxTokens: 1024, topK: 4 },
          responseFormat: "text",
          tools: undefined,
        });
      }
    });

    it("keeps a pending response's original nested schema and enum", async () => {
      const pending = pendingResponse();
      mockRespond.mockReturnValueOnce(pending.promise);
      const enums = ["a", "b"];
      const nested = { value: { type: "integer" } } as const;
      const mutableSchema = {
        kind: { type: "string", enum: enums },
        rows: { type: "array", items: { type: "object", properties: nested } },
      } as const;
      const result = generateObject("extract", {
        mode: "validated",
        schema: mutableSchema,
      });
      enums.splice(0, 2, "c");
      Object.assign(nested.value, { type: "boolean" });
      pending.resolve(output);
      await expect(result).resolves.toEqual(valid);
      expect(mockRespond).toHaveBeenCalledTimes(1);
    });

    it("bounds input and output without repair or truncation", async () => {
      await expect(
        generateObject("x".repeat(65_536), config)
      ).rejects.toMatchObject({ code: "ERR_UNSUPPORTED_REQUEST" });
      expect(mockSessionConstructor).not.toHaveBeenCalled();
      mockRespond.mockResolvedValueOnce("x".repeat(65_537));
      await expect(generateObject("extract", config)).rejects.toMatchObject({
        code: "ERR_UNSUPPORTED_REQUEST",
      });
      expect(mockRespond).toHaveBeenCalledTimes(1);
    });

    it("rejects oversized repair context before starting another session", async () => {
      mockRespond.mockResolvedValueOnce("x".repeat(40_000));
      await expect(
        generateObject("x".repeat(30_000), config)
      ).rejects.toMatchObject({ code: "ERR_UNSUPPORTED_REQUEST" });
      expect(mockRespond).toHaveBeenCalledTimes(1);
    });

    it("does no native work when already aborted", async () => {
      const controller = new AbortController();
      controller.abort();
      await expect(
        generateObject("extract", { ...config, signal: controller.signal })
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(mockSessionConstructor).not.toHaveBeenCalled();
      expect(mockNativeModule.getAvailability).not.toHaveBeenCalled();
    });

    it.each(["resolve", "reject"] as const)(
      "promptly aborts and observes late native %s",
      async (settle) => {
        const controller = new AbortController();
        const add = jest.spyOn(controller.signal, "addEventListener");
        const remove = jest.spyOn(controller.signal, "removeEventListener");
        const pending = pendingResponse();
        mockRespond.mockReturnValueOnce(pending.promise);
        const result = generateObject("extract", {
          ...config,
          signal: controller.signal,
        });
        controller.abort();
        await expect(result).rejects.toMatchObject({ name: "AbortError" });
        expect(mockRelease).toHaveBeenCalledTimes(1);
        expect(remove).toHaveBeenCalledWith("abort", add.mock.calls[0]?.[1]);
        if (settle === "resolve") pending.resolve("{}");
        else pending.reject(new Error("late native failure"));
        await Promise.resolve();
        expect(mockRespond).toHaveBeenCalledTimes(1);
        expect(mockRelease).toHaveBeenCalledTimes(1);
      }
    );

    it("honors abort after native resolution but before JS validation", async () => {
      const controller = new AbortController();
      const pending = pendingResponse();
      mockRespond.mockReturnValueOnce(pending.promise);
      const result = generateObject("extract", {
        ...config,
        signal: controller.signal,
      });
      pending.resolve(output);
      controller.abort();
      await expect(result).rejects.toMatchObject({ name: "AbortError" });
      expect(mockRespond).toHaveBeenCalledTimes(1);
    });

    it("cleans up listeners after success and native failure", async () => {
      const controller = new AbortController();
      const add = jest.spyOn(controller.signal, "addEventListener");
      const remove = jest.spyOn(controller.signal, "removeEventListener");
      mockRespond
        .mockResolvedValueOnce(output)
        .mockRejectedValueOnce(new Error("failure"));
      await generateObject("extract", { ...config, signal: controller.signal });
      await expect(
        generateObject("extract", { ...config, signal: controller.signal })
      ).rejects.toThrow("failure");
      expect(remove).toHaveBeenCalledTimes(2);
      for (const [, listener] of add.mock.calls)
        expect(remove).toHaveBeenCalledWith("abort", listener);
      controller.abort();
      expect(mockRelease).toHaveBeenCalledTimes(2);
    });

    it("handles synchronous abort during construction without responding", async () => {
      const controller = new AbortController();
      mockSessionConstructor.mockImplementationOnce(() => controller.abort());
      await expect(
        generateObject("extract", { ...config, signal: controller.signal })
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(mockRespond).not.toHaveBeenCalled();
    });

    it("handles synchronous abort inside respond and its late rejection", async () => {
      const controller = new AbortController();
      mockRespond.mockImplementationOnce(() => {
        controller.abort();
        return Promise.reject(new Error("native cancelled"));
      });
      await expect(
        generateObject("extract", { ...config, signal: controller.signal })
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(mockRespond).toHaveBeenCalledTimes(1);
    });

    it("does not repair when cancellation arrives between attempts", async () => {
      const controller = new AbortController();
      mockRespond.mockResolvedValueOnce("{}");
      mockRelease.mockImplementationOnce(() => controller.abort());
      await expect(
        generateObject("extract", { ...config, signal: controller.signal })
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(mockRespond).toHaveBeenCalledTimes(1);
    });

    it("aborts the independent repair session without a third attempt", async () => {
      const controller = new AbortController();
      const repair = pendingResponse();
      let repairStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        repairStarted = resolve;
      });
      mockRespond.mockResolvedValueOnce("{}").mockImplementationOnce(() => {
        repairStarted();
        return repair.promise;
      });
      const result = generateObject("extract", {
        ...config,
        signal: controller.signal,
      });
      await started;
      controller.abort();
      await expect(result).rejects.toMatchObject({ name: "AbortError" });
      repair.resolve(output);
      await Promise.resolve();
      expect(mockRespond).toHaveBeenCalledTimes(2);
    });
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
      generateObject("hello", {
        mode: "constrained",
        schema: { name: { type: "string" } },
      })
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
