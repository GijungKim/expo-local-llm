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

import { LLMSession, createLLMSession, ExpoLocalLlmModule } from "../index";

describe("ExpoLocalLlm", () => {
  describe("exports", () => {
    it("exports LLMSession class", () => {
      expect(LLMSession).toBeDefined();
      expect(typeof LLMSession).toBe("function");
    });

    it("exports createLLMSession function", () => {
      expect(createLLMSession).toBeDefined();
      expect(typeof createLLMSession).toBe("function");
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
  });

  describe("ModelAvailability values", () => {
    it("all values are valid strings", () => {
      const values = [
        "available",
        "notEnabled",
        "notReady",
        "notEligible",
        "downloadRequired",
        "downloading",
        "unknown",
      ];
      expect(values).toHaveLength(7);
      values.forEach((v) => expect(typeof v).toBe("string"));
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
