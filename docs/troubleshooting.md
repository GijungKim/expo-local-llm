# Troubleshooting on-device inference

Start by separating build setup, device readiness, and feature support. They are different failure modes.

## Native module unavailable

`moduleUnavailable` means JavaScript could not load the native module. It does not establish whether the device supports a model.

Call `getModuleDiagnostics()` to inspect the native loader message and setup instructions without starting generation.

1. Install the package in the app, not only in a sibling workspace.
2. Build and install a new native development build containing the package. Stock Expo Go does not contain this module.
3. After upgrading the package's native code, rebuild the binary. Restarting Metro or publishing an EAS Update does not install native code.
4. In an existing React Native app, install Expo Modules support before building.

If the problem persists in a rebuilt app, inspect its native build and autolinking logs.

## Model not ready

| Availability | Meaning / next step |
| --- | --- |
| `notEligible` | The current OS/device/backend reports no support. Offer a non-AI path in the app. |
| `notEnabled` | Apple Intelligence is disabled. The user must enable it in system settings. |
| `notReady` | The OS model is not ready yet. Allow system preparation to finish and recheck. |
| `downloadRequired` | Android model download is needed. Expose a user-triggered download action and handle rejection. |
| `downloading` | Model download is in progress. Wait for readiness before generating. |
| `unknown` | Readiness is not established, or the backend status check failed. This is not a permanent hardware-ineligibility verdict. |
| `available` | The model is ready to attempt generation; individual requests can still fail. |

On Android, the SDK also depends on AICore configuration and device support. See Google's [Prompt API setup guidance](https://developers.google.com/ml-kit/genai/prompt/android/get-started#common-setup-issues). Do not assume every phone with a particular marketing name supports the installed SDK.

## Feature unsupported

Use `getCapabilities()` before exposing platform-specific features. This library currently implements tools and constrained structured output on iOS only. Android rejects requests for those features explicitly.

Capability support is not a readiness check. An iOS backend can implement constrained JSON while the model itself is disabled or still preparing.

Android support in this package is narrower than the latest upstream SDK: an upstream feature is not available through this library until its bridge and public contract implement it.

## Request rejected or output invalid

- Model safety refusals and context limits come from the underlying model. Handle them as unsuccessful requests, not as successful empty results.
- `generateObject()` checks the returned JSON against the supplied schema. A `StructuredOutputValidationError` means the object cannot safely be used as the inferred result type.
- A valid schema and valid JSON do not establish factual correctness. Validate application-specific requirements separately.
- Tool handlers receive untrusted arguments. Validate values before using them to call application APIs.

## Sessions and cancellation

Use one active generation per session. Keep separate sessions for separate conversations; model backends may still impose device-wide limits. Await the generation promise settling after cancellation before starting another request on the same session.

Use `generate()` or `generateObject()` for independent tasks so conversation history does not accumulate. For manual sessions, call `release()` when finished. `useLocalLLM()` manages its own session lifecycle.

One-shot helpers do not install tool handlers. Use the hook for automatic tool dispatch, or subscribe to the low-level session's `toolCall` events and explicitly resolve or reject calls.

## Reporting a problem

Include the package version, Expo SDK, native build toolchain, device/OS, availability, requested capability, and a minimal reproduction. State whether the failure is during compilation, native module loading, model preparation, or inference. Use a synthetic prompt that reproduces the problem rather than private user input.
