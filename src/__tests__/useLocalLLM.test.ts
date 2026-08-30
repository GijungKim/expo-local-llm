import ExpoLocalLlmModule from "../ExpoLocalLlmModule";

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

describe("useLocalLLM prerequisites", () => {
  it("native module is null in test environment", () => {
    expect(ExpoLocalLlmModule).toBeNull();
  });

  it("useLocalLLM can be imported", () => {
    const mod = require("../useLocalLLM");
    expect(mod.useLocalLLM).toBeDefined();
    expect(mod.useLocalLLM).toEqual(expect.any(Function));
  });
});
