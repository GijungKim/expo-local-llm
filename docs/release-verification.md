# Release verification

Native compilation and device behavior are separate release criteria. A compile-only build (including the CI simulator build) does not verify model availability, output quality, or cancellation. A simulator *run* on a Mac with Apple Intelligence enabled can verify those behaviors for iOS; performance characteristics still require physical hardware.

## Compatibility claims

- The example targets Expo SDK 58 / React Native 0.88.
- The package's Expo `>=52` peer range describes dependency acceptance, not a promise that every SDK/toolchain combination has been tested.
- The SDK 58 example requires Xcode 26.4+ with the Foundation Models SDK. The deployment floor is iOS 16.4; inference requires eligible iOS 26+ hardware and Apple Intelligence enabled.
- Building with Xcode 27 requires the UIKit scene lifecycle, which Expo SDK 58 adopts by default and SDK 57 enables with `ios.enableSceneSupport: true` (see the [Xcode 27 note](../README.md#xcode-27-requires-scene-support)). Without it UIKit stops the app at launch before JavaScript runs, which is a launch-time failure the compile-only native job cannot detect.
- Apple Foundation Models can run in the iPhone simulator when the host Mac has Apple Intelligence enabled and ready. Physical hardware is still required for latency, memory, and thermal measurements.
- Android requires `minSdkVersion` 26+ and Kotlin 2.3.0+ for ML Kit beta5 / Schema alpha2, and remains experimental. Device eligibility must be checked at runtime; a device marketing name alone is not proof of SDK support.

## Local checks

The [native compile workflow and scripts](../tools/native-check/README.md) generate fresh example projects and compile both platforms. These are compile gates, separate from the physical-device record below.

From the repository root:

```sh
bun install --frozen-lockfile
bun run lint
bun run test:anti-slop
bun run test:build-script
bun run knip
bun run test -- --runInBand
bun run typecheck
bun run test:types
bun run build
```

For compiler or emitter updates, compare the generated JavaScript and declarations
against the retained TypeScript 6 build, including the emitted file inventory.
Review changed source maps for accurate debugging and declaration navigation;
byte differences alone are not a failure. Verify a locally packed package with
lifecycle scripts disabled in an isolated TypeScript consumer before publishing.
Do not hide a `tsrs` compilation failure by retrying with another compiler.

Build the example on each platform with the native toolchains installed:

```sh
cd example
bun install
npx expo run:ios --device
# or
npx expo run:android --device
```

Do not run both platform commands blindly: select the connected device appropriate to the platform. The example's local package dependency must include the latest root build.

## Model check (macOS)

`tools/model-check/run.sh` runs the library's Foundation Models code against the real system model on a Mac with Apple Intelligence: constrained tool arguments, tool-failure and context-overflow error codes, and schema-constrained output. Run it for every release and after any Swift change to tools, schemas or errors. See [its README](../tools/model-check/README.md) for what it does and does not cover.

## Physical-device release record

For each release, record the package commit, Expo SDK, native SDK/toolchain, device model, OS version, and actual result. Keep failed and unsupported cases explicit. Do not carry results forward from an older OS-managed model without rerunning the checks.

| Scenario | iOS result | Android result |
| --- | --- | --- |
| Eligibility, disabled/not-ready model, and ready state | Ready (`available`) confirmed on simulator and iPhone 15 Pro. Disabled and not-ready states not exercised | Module loaded and reported `notEligible` on Galaxy A17; the app stayed usable |
| Missing native module gives rebuild guidance | Pending | Pending |
| Text response and streaming final text | Verified on simulator and iPhone 15 Pro (streamed text rendered, final text matched) | Not validated — no Gemini Nano device available; library-side prompt assembly is covered by JVM tests |
| Image response and streaming; text-only model behavior | Image streaming completed on iPhone Duo (iOS 27.2) and simulator (iOS 27.1), package 0.9.0 working tree. One-shot/schema image generation and rejection on non-vision models/older builds remain pending | Pending — support for up to eight images per request is implemented; inference on an image-capable Gemini Nano device is not validated |
| Image EXIF rotation/mirroring, large images, unreadable files, cancel during decode/inference, and recovery | Pending device checks | Pending device checks |
| Cancel stops generation; next request succeeds and retains earlier completed turns | Cancel and next-request success verified on simulator; retention of earlier completed turns not explicitly exercised | Pending |
| Overlapping requests rejected without corrupting history | Pending | Pending |
| Reset during generation does not restore old history | Pending | Pending |
| Queued output/tool events from before reset cannot affect the next request | Pending | Pending |
| Unmount/release while generating | Pending | Pending |
| Model download succeeds and recovers after failure | Not applicable | Pending |
| Structured object passes nested schema validation | Verified on simulator and iPhone 15 Pro (object with string, array, and enum fields) | Unsupported, and rejection is clean: a clear error is surfaced and the app stays usable (verified on Galaxy A17) |
| Tool success, rejection, timeout, and teardown | Success (constrained arguments) and rejection (`ERR_TOOL_FAILED`) verified by the model check on macOS 27. Timeout and teardown pending; the example UI exposes no tools | Pending — native tool loop implemented; selected-model feature support and real function calling need hardware verification |

“Pending” is intentional: this document is a checklist, not fabricated device evidence. Complete the relevant rows before claiming a platform is device-verified.

### Recorded runs

| Run | Environment | Result |
| --- | --- | --- |
| Simulator | iPhone 18 Pro, iOS 27.0 runtime, host Mac with Apple Intelligence enabled; Expo SDK 57.0.25, React Native 0.86.2, Xcode 27.0; package at `c95a978` | Ready, text, JSON, cancel, and recovery passed |
| Physical device | iPhone 15 Pro, iOS 27.0, Apple Intelligence enabled; same toolchain and package revision | Ready, text, and JSON passed |
| Physical device (Android) | Galaxy A17 (SM-A176U1), Android 16 / SDK 36, arm64; Expo SDK 57.0.25, React Native 0.86.2, JDK 17, SDK build-tools 36.0.0, NDK 27.1.12297006 | Module loaded, `notEligible` reported, structured output rejected cleanly |
| Physical device, SDK 58 | iPhone 15 Pro, iOS 27.0.1, Apple Intelligence enabled; Expo SDK 58.0.11, React Native 0.88.0, Xcode 27.0; Release build; package 0.8.1 | Launched with the generated scene delegate; ready, text, JSON (enum field constrained), cancel, and recovery passed |
| Physical device, 2026-11-05 | iPhone Duo (`iPhone19,4`), iOS 27.2, Apple Intelligence ready; Expo SDK 58.0.11, React Native 0.88.0, Xcode 27.1; signed Release build; package 0.9.0 working tree based on `1b79bd4` | Driven with Argent over USB. Ready, completed text response, and structured recipe JSON with string, array, and enum fields passed. Cancellation and image rejection were not exercised in this run |
| Simulator, 2026-11-05 | iPhone Duo, iOS 27.1 runtime, host Mac with Apple Intelligence ready; same SDK 58 dependencies and Xcode 27.1; Release build; package 0.9.0 working tree based on `1b79bd4` | Driven with Argent. Ready, text response, and structured recipe JSON passed. Argent recorded field-by-field JSON generation; the temporary clip is separate from the physical-device checks |
| Image input, 2026-11-05 | iPhone Duo (`iPhone19,4`), iOS 27.2; iPhone Duo simulator, iOS 27.1; Expo SDK 58.0.11, React Native 0.88.0, Xcode 27.1; Release builds; package 0.9.0 working tree based on `1b79bd4` | Argent drove both targets and recorded the simulator. A bundled PNG contains a red triangle followed by a blue circle. The prompt and attachment label do not name either shape or color. Both completed image streaming and described a red triangle followed by a blue oval. This confirms image input/inference, not perfect task accuracy. One earlier simulator run additionally hallucinated a third shape. No Gemini image inference was run |
| Multiple images, 2026-11-05 | iPhone Duo simulator, iOS 27.1 runtime, host Apple Intelligence ready; Expo SDK 58.0.11, React Native 0.88.0, Xcode 27.1; Release build; 0.9.0 working tree based on `cbb9a9c` | Two image attachments streamed a completed comparison through Argent: first red triangle / blue circle, second green square / yellow triangle. The model described all four objects and colors, calling the circle an oval. An eight-image cap and unique-label validation are implemented; iOS eight-image and boundary-error checks remain pending. Android inference was not exercised in this run |
| Physical device, multiple images, 2026-11-05 | iPhone Duo (`iPhone19,4`), iOS 27.2, Apple Intelligence ready; Expo SDK 58.0.11, React Native 0.88.0, Xcode 27.1; Release build; 0.9.0 working tree based on `cbb9a9c` | Argent drove a completed two-image comparison. The model described the first image as a red triangle and blue oval, and the second as a green square and yellow triangle. Prompts and labels did not contain the answers. Full eight-image, boundary-error, and image-specific cancellation checks remain pending |
| Physical device (Android), SDK 58 | Galaxy A17 (SM-A176U1), Android 16 / SDK 36, arm64; Expo SDK 58.0.11, React Native 0.88.0, AGP 9.2.1, compile SDK 37; Release build with R8 minification; package 0.8.1 | Module loaded and `notEligible` reported. Without 0.8.1's keep rule the same build reported `unknown` |

The SDK 57 runs used the debug example app; the SDK 58 runs used Release builds, which bundle the JavaScript and, on Android, minify with R8. They establish that inference, structured output, and cancellation work; they do not measure latency, memory, or thermal behavior, which still require a dedicated performance pass.

For task-quality measurements, keep a small fixed input set for classification and extraction. Report success rate and latency alongside the device/OS and prompt/schema versions. Do not treat syntactically valid JSON as evidence that the answer is semantically correct.

Before publishing a release, check that its capability flags, README guarantees, and recorded device results agree. A new upstream SDK feature must be implemented and checked locally before it is exposed, and remain explicitly experimental until the relevant device checks pass.

## Android native tools — 0.9.0 verification

The default model remains STABLE + FULL. PREVIEW + FAST requires explicit `androidModel: 'previewFast'`; readiness, download, session creation, and module events must all use that selection. Verify eligible hardware and AICore Developer Preview enrollment before attempting native function calling. `getCapabilities().tools` is an integration-version gate; `getModelReadiness(selection)` reports model availability separately from `available | unavailable | unknown` tool support. Old binaries reject explicit preview rather than silently using default.

Local compiler evidence (2026-11-05): a focused compile of runtime declarations, schemas, nullable-ID function responses, and `setTools` succeeds with Kotlin 2.3.0; Kotlin 2.2.21 rejects the artifacts' 2.4 metadata. No metadata-skip flags. The library keeps min SDK 26, compile SDK 35, and coroutines 1.11.0. The generated SDK 58 example and app config pin Kotlin 2.3.0. See [native check instructions](../tools/native-check/README.md#android-tool-calling-compiler-floor) for the local Debug, JVM, and R8 Release commands.

Local verification of the 0.9.0 working tree based on `03ced783` (2026-11-05): 81 JS tests and 47 JVM tests passed. Typecheck, type-level tests, repository lint, typed lint, knip, package build, size check, and example checks with both tsrs and TypeScript passed. Typed lint retains two existing unbound-method warnings; the shared anti-slop checker reports the five existing `jest.mock` declarations in the two edited test files, with no new findings. Standalone JS is 14,582 bytes minified / 4,886 bytes gzipped; reviewed budgets are 15,000 / 5,000 bytes.

Android autolinking, Kotlin compilation, and arm64-only Debug and R8 Release packaging passed on JDK 17. The final run forced `:app:createBundleReleaseJsAndAssets --rerun` and used local Gradle overrides `-Dorg.gradle.jvmargs="-Xmx4096m -XX:MaxMetaspaceSize=768m" --max-workers=2`; these overrides are not project settings. Release APK SHA-256: `d440d419bba502bb85b0f79ef49bc590168f946f482417ed69f169236e52e2d2`. No iOS build was run because Apple native sources are unchanged. SDK JVM test limitations are recorded in the native-check documentation.

Pending on supported Android hardware (no tool inference, model download, or device mutation performed for this implementation):

- Confirm default and preview readiness remain isolated, including service/query failures and download events; verify feature-gate rejection on a selected model without function calling.
- Run respond and streaming with multiple tool rounds and multiple calls per batch. Confirm model text is preserved and exactly one terminal stream event occurs, without dispatching partial callback calls.
- Verify handler success/rejection/timeout, immediate resolution, cancellation, reset, release, registration changes, and stale resolutions across a new request.
- Exercise 8 tool-bearing rounds, 32 total calls, the default 30-second configurable timeout, and the 65,536 UTF-8 byte result limit; confirm failures carry `ERR_TOOL_FAILED` with no automatic handler retry.
- Verify actual native MODEL call / USER result replay with null SDK IDs and opaque string results, atomic ten-exchange history trimming, and images available across internal tool turns but absent from persisted history.
- Recheck text/image generation without tools, automatic validated `generateObject()`, and explicit native JSON/constrained rejection. Arbitrary runtime JS schemas cannot be passed to the SDK's compiled-Kotlin-type structured-output API.

These checks remain pending regardless of successful APK compilation. Android stays experimental. Apple native files are unchanged by this implementation.

After source review, four additional regression tests passed (51 JVM tests total): repeated non-null SDK IDs are rejected across rounds before any handler in the affected batch starts; distinct and null IDs remain supported. Generation readiness now distinguishes unavailable models from confirmed feature absence and preserves SDK query failures for normal error mapping. Cancellation propagates unchanged. The JVM suite exercises production helpers, not full `LLMSession` integration; the pending orchestration and image-request checks above remain open.

Debug and R8 arm64 Release packaging passed again after these Kotlin fixes. The updated Release APK SHA-256 is `772a423a34bbb2979eaf7edae9199af703cd0d69a0adfab5e17491e3b5e14c91`. JavaScript was unchanged from the earlier verified bundle.

## Explicit validated output — 0.9.0 verification

This JS-only increment is based on `5165adc393cc0d8cba94953b78249a8d9090da26`. `generateObject()` with explicit `mode: 'validated'` uses native text generation and JS schema validation, with zero or one additional repair request. `getCapabilities().text` detects the integration; selected-model readiness remains a separate check. `structuredOutput` and `structuredOutputMode` still describe native constrained decoding. Default/constrained requests remain rejected on Android. No native files or tool behavior changed.

The public-path tests in `src/__tests__/nativeApi.test.ts` use the existing native-present harness: nested and enum validation; malformed JSON, extra/missing fields and repair exhaustion; SDK/refusal/guardrail/query failures without retry; unsupported integrations and missing module; invalid config/schema and tools rejected before construction; task/schema/image/model/options snapshots; bounded output/repair context; cancellation before/during/between requests and synchronous/late native settlement; listener cleanup and exactly one release per constructed session. Type fixtures cover validated options, inference, and rejected option combinations. Regression coverage also rejects array-shaped root/property/field containers before session construction and verifies enum snapshots ignore overridden copying methods, array species, and serialization hooks. These are JS tests with a native bridge test double, not device inference evidence.

Local verification (2026-11-05): all 155 JS tests passed, including 91 native-present API tests. Typecheck and type fixtures (now including the native API test file), repository lint, typed lint, knip, package build, and example typechecks with both tsrs and TypeScript passed. The anti-slop rule tests (40), typed-lint test (1), and build-script tests (14) also passed; `git diff --check` passed. Typed lint retains the two existing unbound-method warnings. The shared anti-slop command was run directly on all seven changed/new JS/TS/mjs files because no trusted lifecycle-hook execution was observed; its 14 findings are pre-existing: two `jest.mock` declarations in `nativeApi.test.ts` and 12 runtime-validation findings in `validateSchema.ts`, reproduced against the `5165adc` version of that file. No mocks or suppressions were added. The prior native-tools increment's five mock findings include three in its other test file, which this increment does not edit.

Size review: Bun 1.4.4 measures 17,700 bytes minified / 5,988 gzipped, versus the `5165adc` baseline of 14,582 / 4,886 (increases of 3,118 / 1,102 bytes). The added implementation supplies input snapshots, bounds, cancellation cleanup, and the explicit repair loop without new runtime dependencies. Reviewed budgets are 18,000 minified / 6,200 gzip bytes; CI continues to enforce them.

Pending on compatible iOS and Android hardware: successful extraction with each selected model; frequency and latency of validation repair; native errors, context/token limits and cancellation; image attachments retained during repair. No device actions, APK builds, or Xcode builds were performed for this JS-only increment. Android remains experimental.

## 0.9.0 release preflight — 2026-11-05

The release is based on `e723da3` (PR #80), whose four CI checks passed. The final local lint, 155 JS tests, 40 anti-slop rule tests, 14 build-script tests, knip, source/type-fixture checks, package build, and size check passed again. The macOS 27.0 (26A428), Apple silicon system-model check passed all four scenarios: constrained tool arguments, failed-handler error mapping, context-overflow error mapping, and structured schema output. This does not validate the new JS validated-output path or Android inference.

The clean prepublish build and packed artifact inspection passed. An isolated TypeScript consumer installed the tarball with lifecycle scripts disabled and verified validated-mode options, inferred enum output, model selection, and image prompt types. The package includes compiled JS/declarations and both native integrations; example assets and native build artifacts are excluded. The existing device-test gaps above remain open, and Android remains experimental.

## Android session reliability — unreleased

The production `LLMSession` now has a narrow injectable client/event/dispatcher boundary. JVM tests run its actual response, streaming, tool-loop, history, cancellation, reset/release, and model-ownership code using real SDK request/response values and scripted responses. They do not replace the session algorithm or contact AICore. The new tests include final-response/callback reconciliation, stale callbacks, invalid batches, registration changes, failure recovery, and delayed producer cleanup. Per-model lock isolation is tested independently; real SDK download behavior remains a device check.

Local verification on 2026-11-05: 64 JVM tests and 163 JS tests passed. The hook regressions cover terminal download progress, selected-model errors, foreground readiness recovery, and preservation of generation failures. Typechecks, lint, typed lint, knip, package build and size checks passed. Shared anti-slop reports only the three pre-existing module mocks in the edited hook test file; typed lint retains its two existing warnings. Standalone JS measures 17,829 minified / 6,029 gzip bytes, within existing budgets.

Two connected Android tests passed on an API 36 arm64 emulator using ART and actual ML Kit beta5 image/request classes. They drive production sessions through 0/1/8-image requests, assert bitmap/label order and generation options, preserve bitmap identity through an internal tool round, and verify later history contains no images. Model results are scripted: no Gemini Nano inference runs. The emulator used a read-only AVD with snapshot saving disabled. The standalone instrumentation APK used the documented compile-SDK-37 test override to satisfy Expo SDK 58 dependency metadata; production remains on compile SDK 35.

Debug and R8-minified arm64 Release APK packaging passed with a freshly generated Release JavaScript bundle. The connected ART tests ran before the final cancellation-lock adjustment. The subsequent incremental run covered JVM tests and APK packaging, not connected ART tests. No iOS native files changed.

Remaining limits: eligible-device AICore behavior, actual downloads, model output quality, SDK bitmap use during inference cancellation, latency/memory/thermal performance, and the Expo JavaScript-to-native runtime transport are not established by these tests. Android remains experimental.

Review follow-up: terminal tool-stream text is authoritative when callbacks diverge, including an empty final text; a corrective token event carries the replacement accumulated value. Regression tests cover multiple streaming tool rounds, cancellation while a handler is pending, and clearing stale readiness errors on generation/reset. The precise cancellation window between SDK return and reconciliation is guarded in source but not deterministically exercised by these tests. Connected ART tests were not rerun for this follow-up.

## Automatic structured output — unreleased

Default `generateObject()` calls now choose native constrained decoding on supported Apple integrations and validated text generation on Android. The Android path retains strict runtime schema validation and at most one repair request; native/provider failures do not trigger repair or switch paths. `getCapabilities().objectGenerationMode` reports the automatic selection, while the existing structured-output fields remain native-only. Explicit constrained and validated modes are unchanged. No native code or backend changed, and Gemini Nano inference remains pending on supported hardware.

Local verification on 2026-11-05: all 169 JS tests passed, including automatic Android routing, repair, provider-failure, unsupported-platform, and missing-module cases. Source and type-fixture checks, lint, typed lint, knip, package build, and size check passed. Typed lint retains its two existing unbound-method warnings. The shared anti-slop checker reports only the four existing module mocks in the two edited test files. Standalone JS measures 17,990 bytes minified / 6,059 gzip bytes, within the existing 18,000 / 6,200 budgets.
