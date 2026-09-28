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

## Device is not detected

"The phone isn't visible to the dev tooling" and "the model isn't ready" look similar in an error dialog but have different causes. Start with what the tooling sees:

```sh
adb devices -l
```

| Output | Meaning | Fix |
| --- | --- | --- |
| empty list | adb sees no USB device at all | use a data-capable cable in a direct port; charge-only cables and unpowered hubs are the usual cause |
| `unauthorized` | the phone is connected but this Mac hasn't been authorized | unlock the phone and accept the "Allow USB debugging?" prompt |
| `device` | connected and authorized | the app still needs to reach Metro — see below |

`adb devices` is the authoritative signal. `system_profiler SPUSBDataType` can report nothing even on a working connection when the shell is sandboxed, so do not treat it as evidence.

If the phone never appears, confirm the device-side settings before blaming the cable:

```sh
adb shell settings get global development_settings_enabled   # 1 = Developer options enabled
adb shell settings get global adb_enabled                    # 1 = USB debugging enabled
```

Two things that are commonly suspected but usually innocent:

- **USB mode.** Charging-only does not block adb; `sys.usb.config` showing something like `sec_charging,adb` is sufficient.
- **Re-authorization.** Once this machine's key is trusted (`~/.android/adbkey`), the phone will not prompt again even if USB debugging is toggled off and back on.

If the device is `device` but the app reports a bundle or connection error, the app is not reaching Metro:

```sh
adb reverse tcp:8081 tcp:8081
```

`npx expo run:android --device` takes a **device name**, not an adb serial; passing the serial fails with "Could not find device with name". To target one device deterministically, build and install directly:

```sh
cd example/android
ANDROID_SERIAL=<serial> ./gradlew :app:installDebug
adb -s <serial> reverse tcp:8081 tcp:8081
adb -s <serial> shell am start -n <applicationId>/.MainActivity
```

## Android build fails on JDK 24 or newer

Native configuration fails with:

```
Execution failed for task ':app:configureCMakeDebug[x86_64]'.
> WARNING: A restricted method in java.lang.System has been called
```

JDK 24 began restricting native access (JEP 472) and Gradle's CMake configure step trips it. Either use JDK 17–21, or keep JDK 24+ and opt in:

```sh
JAVA_TOOL_OPTIONS=--enable-native-access=ALL-UNNAMED npx expo run:android
```

This is a property of the Android toolchain on this Expo SDK rather than of this library, so it applies to any project built the same way.

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
