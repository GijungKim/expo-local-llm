# Release verification

Native compilation and device behavior are separate release criteria. A compile-only build (including the CI simulator build) does not verify model availability, output quality, or cancellation. A simulator *run* on a Mac with Apple Intelligence enabled can verify those behaviors for iOS; performance characteristics still require physical hardware.

## Compatibility claims

- The example targets Expo SDK 57 / React Native 0.86.
- The package's Expo `>=52` peer range describes dependency acceptance, not a promise that every SDK/toolchain combination has been tested.
- The SDK 57 example requires Xcode 26.4+ with the Foundation Models SDK. The deployment floor is iOS 16.4; inference requires eligible iOS 26+ hardware and Apple Intelligence enabled.
- Building with Xcode 27 requires `ios.enableSceneSupport: true` (see the [Xcode 27 note](../README.md#xcode-27-requires-scene-support)). Without it UIKit stops the app at launch before JavaScript runs, which is a launch-time failure the compile-only native job cannot detect.
- Apple Foundation Models can run in the iPhone simulator when the host Mac has Apple Intelligence enabled and ready. Physical hardware is still required for latency, memory, and thermal measurements.
- Android requires `minSdkVersion` 26+ and remains experimental. Device eligibility must be checked at runtime; a device marketing name alone is not proof of SDK support.

## Local checks

The [native compile workflow and scripts](../tools/native-check/README.md) generate fresh example projects and compile both platforms. These are compile gates, separate from the physical-device record below.

From the repository root:

```sh
bun install --frozen-lockfile
bun run lint
bun run test:anti-slop
bun run knip
bun run test -- --runInBand
bun run test:types
bun run build
```

Build the example on each platform with the native toolchains installed:

```sh
cd example
bun install
npx expo run:ios --device
# or
npx expo run:android --device
```

Do not run both platform commands blindly: select the connected device appropriate to the platform. The example's local package dependency must include the latest root build.

## Physical-device release record

For each release, record the package commit, Expo SDK, native SDK/toolchain, device model, OS version, and actual result. Keep failed and unsupported cases explicit. Do not carry results forward from an older OS-managed model without rerunning the checks.

| Scenario | iOS result | Android result |
| --- | --- | --- |
| Eligibility, disabled/not-ready model, and ready state | Ready (`available`) confirmed on simulator and iPhone 15 Pro. Disabled and not-ready states not exercised | Module loaded and reported `notEligible` on Galaxy A17; the app stayed usable |
| Missing native module gives rebuild guidance | Pending | Pending |
| Text response and streaming final text | Verified on simulator and iPhone 15 Pro (streamed text rendered, final text matched) | Not validated — no Gemini Nano device available; library-side prompt assembly is covered by JVM tests |
| Cancel stops generation; next request succeeds and retains earlier completed turns | Cancel and next-request success verified on simulator; retention of earlier completed turns not explicitly exercised | Pending |
| Overlapping requests rejected without corrupting history | Pending | Pending |
| Reset during generation does not restore old history | Pending | Pending |
| Queued output/tool events from before reset cannot affect the next request | Pending | Pending |
| Unmount/release while generating | Pending | Pending |
| Model download succeeds and recovers after failure | Not applicable | Pending |
| Structured object passes nested schema validation | Verified on simulator and iPhone 15 Pro (object with string, array, and enum fields) | Unsupported, and rejection is clean: a clear error is surfaced and the app stays usable (verified on Galaxy A17) |
| Tool success, rejection, timeout, and teardown | Pending — the example UI exposes no tools | Unsupported; verify explicit rejection |

“Pending” is intentional: this document is a checklist, not fabricated device evidence. Complete the relevant rows before claiming a platform is device-verified.

### Recorded runs

| Run | Environment | Result |
| --- | --- | --- |
| Simulator | iPhone 18 Pro, iOS 27.0 runtime, host Mac with Apple Intelligence enabled; Expo SDK 57.0.25, React Native 0.86.2, Xcode 27.0; package at `c95a978` | Ready, text, JSON, cancel, and recovery passed |
| Physical device | iPhone 15 Pro, iOS 27.0, Apple Intelligence enabled; same toolchain and package revision | Ready, text, and JSON passed |
| Physical device (Android) | Galaxy A17 (SM-A176U1), Android 16 / SDK 36, arm64; Expo SDK 57.0.25, React Native 0.86.2, JDK 17, SDK build-tools 36.0.0, NDK 27.1.12297006 | Module loaded, `notEligible` reported, structured output rejected cleanly |

Both runs used the debug example app. They establish that inference, structured output, and cancellation work; they do not measure latency, memory, or thermal behavior, which still require a dedicated performance pass.

For task-quality measurements, keep a small fixed input set for classification and extraction. Report success rate and latency alongside the device/OS and prompt/schema versions. Do not treat syntactically valid JSON as evidence that the answer is semantically correct.

Before publishing a release, check that its capability flags, README guarantees, and recorded device results agree. A new upstream SDK feature should remain unsupported in the public API until the library implements and verifies it.
