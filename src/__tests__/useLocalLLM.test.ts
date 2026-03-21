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

jest.mock("react", () => ({
  ...jest.requireActual("react"),
}));

import ExpoLocalLlmModule from "../ExpoLocalLlmModule";

describe("useLocalLLM prerequisites", () => {
  it("native module is null in test environment", () => {
    expect(ExpoLocalLlmModule).toBeNull();
  });

  it("useLocalLLM can be imported", () => {
    const mod = require("../useLocalLLM");
    expect(mod.useLocalLLM).toBeDefined();
    expect(typeof mod.useLocalLLM).toBe("function");
  });
});
