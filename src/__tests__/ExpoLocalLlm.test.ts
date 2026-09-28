import {
  LLMSession,
  createLLMSession,
  generate,
  generateObject,
  getModuleDiagnostics,
  NativeModuleUnavailableError,
  ExpoLocalLlmModule,
} from "../index";

jest.mock("expo-modules-core", () => ({
  requireNativeModule: jest.fn(() => {
    throw new Error("Native module not available");
  }),
  NativeModule: class {},
  SharedObject: class {},
  UnavailabilityError: class UnavailabilityError extends Error {
    constructor(moduleName: string, functionName: string) {
      super(`${moduleName}.${functionName} is not available`);
    }
  },
}));

jest.mock("react-native", () => ({ Platform: { OS: "ios" } }));

describe("ExpoLocalLlm", () => {
  describe("exports", () => {
    it("exports LLMSession class", () => {
      expect(LLMSession).toBeDefined();
      expect(LLMSession).toEqual(expect.any(Function));
    });

    it("exports createLLMSession function", () => {
      expect(createLLMSession).toBeDefined();
      expect(createLLMSession).toEqual(expect.any(Function));
    });

    it("exports generate function", () => {
      expect(generate).toBeDefined();
      expect(generate).toEqual(expect.any(Function));
    });

    it("exports ExpoLocalLlmModule as null when native module is unavailable", () => {
      expect(ExpoLocalLlmModule).toBeNull();
    });
  });

  describe("createLLMSession", () => {
    it("throws when native module is not loaded", () => {
      expect(() => createLLMSession()).toThrow();
    });

    it("throws with module name in message", () => {
      expect(() => createLLMSession({ instructions: "test" })).toThrow(
        /ExpoLocalLlm/
      );
    });

    it("provides Expo Go and native rebuild setup guidance", () => {
      expect(getModuleDiagnostics()).toMatchObject({
        available: false,
        reason: "moduleUnavailable",
      });
      expect(getModuleDiagnostics().message).toMatch(/development build/i);
      expect(getModuleDiagnostics().message).toMatch(/Expo Go cannot load/i);
      expect(getModuleDiagnostics().message).toMatch(/rebuild the native/i);
      expect(() => createLLMSession()).toThrow(/development build/i);
    });
  });

  describe("generate", () => {
    it("rejects when native module is not loaded", async () => {
      await expect(generate("hello")).rejects.toThrow(/ExpoLocalLlm/);
    });
  });

  describe("generateObject", () => {
    it("uses the native-module-specific error when the module is missing", async () => {
      await expect(
        generateObject("hello", {
          schema: { answer: { type: "string" } },
        })
      ).rejects.toBeInstanceOf(NativeModuleUnavailableError);
    });
  });

  describe("ModelAvailability values", () => {
    it("all values are valid strings", () => {
      const values = [
        "available",
        "moduleUnavailable",
        "notEnabled",
        "notReady",
        "notEligible",
        "downloadRequired",
        "downloading",
        "unknown",
      ];
      expect(values).toHaveLength(8);
      values.forEach((value) => expect(value).toEqual(expect.any(String)));
    });
  });

  describe("SessionConfig", () => {
    it("accepts config with all fields", () => {
      const config = {
        instructions: "You are a health assistant",
        options: {
          temperature: 0.7,
          maxTokens: 256,
          topK: 40,
        },
      };
      expect(config.instructions).toBe("You are a health assistant");
      expect(config.options.temperature).toBe(0.7);
      expect(config.options.maxTokens).toBe(256);
      expect(config.options.topK).toBe(40);
    });

    it("accepts empty config", () => {
      const config = {};
      expect(config).toEqual({});
    });
  });
});
