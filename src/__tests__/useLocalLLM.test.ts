import React from "react";
import TestRenderer, { act } from "react-test-renderer";

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

jest.mock("react-native", () => ({ Platform: { OS: "ios" } }));

describe("useLocalLLM prerequisites", () => {
  it("native module is null in test environment", () => {
    expect(ExpoLocalLlmModule).toBeNull();
  });

  it("useLocalLLM can be imported", () => {
    const mod = require("../useLocalLLM");
    expect(mod.useLocalLLM).toBeDefined();
    expect(mod.useLocalLLM).toEqual(expect.any(Function));
  });

  it("reports moduleUnavailable instead of hardware ineligibility", async () => {
    const { useLocalLLM } = require("../useLocalLLM");
    let availability: string | undefined;
    let error: string | null | undefined;
    function Consumer() {
      const result = useLocalLLM();
      availability = result.availability;
      error = result.error;
      return null;
    }
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(Consumer));
    });
    expect(availability).toBe("moduleUnavailable");
    expect(error).toMatch(/development build/i);
    await act(async () => renderer.unmount());
  });
});
