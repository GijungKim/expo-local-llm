# Release verification

Native compilation and physical-device inference are separate release criteria. A passing JavaScript test suite or simulator build does not verify model availability, output quality, or cancellation on hardware.

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
| Eligibility, disabled/not-ready model, and ready state | Pending | Pending |
| Missing native module gives rebuild guidance | Pending | Pending |
| Text response and streaming final text | Pending | Pending |
| Cancel stops generation; next request succeeds and retains earlier completed turns | Pending | Pending |
| Overlapping requests rejected without corrupting history | Pending | Pending |
| Reset during generation does not restore old history | Pending | Pending |
| Queued output/tool events from before reset cannot affect the next request | Pending | Pending |
| Unmount/release while generating | Pending | Pending |
| Model download succeeds and recovers after failure | Not applicable | Pending |
| Structured object passes nested schema validation | Pending | Unsupported; verify explicit rejection |
| Tool success, rejection, timeout, and teardown | Pending | Unsupported; verify explicit rejection |

“Pending” is intentional: this document is a checklist, not fabricated device evidence. Complete the relevant rows before claiming a platform is device-verified.

For task-quality measurements, keep a small fixed input set for classification and extraction. Report success rate and latency alongside the device/OS and prompt/schema versions. Do not treat syntactically valid JSON as evidence that the answer is semantically correct.

Before publishing a release, check that its capability flags, README guarantees, and recorded device results agree. A new upstream SDK feature should remain unsupported in the public API until the library implements and verifies it.
