# expo-local-llm

[![npm](https://img.shields.io/npm/v/expo-local-llm)](https://www.npmjs.com/package/expo-local-llm)
[![CI](https://github.com/GijungKim/expo-local-llm/actions/workflows/ci.yml/badge.svg)](https://github.com/GijungKim/expo-local-llm/actions/workflows/ci.yml)
[![Native compile](https://github.com/GijungKim/expo-local-llm/actions/workflows/native.yml/badge.svg)](https://github.com/GijungKim/expo-local-llm/actions/workflows/native.yml)
[![License: MIT](https://img.shields.io/npm/l/expo-local-llm)](LICENSE)

On-device language models for Expo apps, using the models the operating system already ships: Apple Foundation Models on iOS 26+ and Gemini Nano on Android. Generate text, stream it into a component, extract typed objects and call tools, with no model weights to bundle, no API key, and no network connection needed to generate.

Inference stays on the device. There is no cloud fallback; network access happens only inside tool handlers you write. The package has no runtime dependencies.

## At a glance

| | iOS 26+ (Foundation Models) | Android (Gemini Nano) |
|---|---|---|
| Text generation and streaming | ✅ Verified on device | ⚠️ Experimental: builds and reports eligibility; generation not yet validated on Gemini Nano hardware |
| Structured output (typed, schema-constrained) | ✅ Constrained decoding, validated in JS | ❌ Rejected explicitly |
| Tool calling (schema-constrained arguments) | ✅ | ❌ Rejected explicitly |
| Stable error codes | ✅ | ✅ |
| Model download | Managed by the OS | `downloadModel()` with progress |

Unsupported features fail with a clear error instead of degrading silently. `getCapabilities()` reports all of this at runtime, including `experimental: true` on Android. See [how this library is verified](#how-this-library-is-verified).

## Quick start

```bash
npx expo install expo-local-llm expo-dev-client expo-build-properties
```

Set the deployment targets the module needs in `app.json`:

```json
{
  "expo": {
    "plugins": [
      [
        "expo-build-properties",
        {
          "ios": { "deploymentTarget": "16.4" },
          "android": { "minSdkVersion": 26 }
        }
      ]
    ]
  }
}
```

Build a development app, since stock Expo Go cannot load native modules:

```bash
npx expo run:ios --device
```

Then stream a response:

```tsx
import { Button, Text } from 'react-native';
import { useLocalLLM } from 'expo-local-llm';

export function Summary({ notes }: { notes: string }) {
  const { availability, streamResponse, streamedText, error } = useLocalLLM({
    instructions: 'Summarise the text in two sentences.',
  });

  if (!streamResponse) return <Text>{error ?? `On-device AI: ${availability}`}</Text>;
  return (
    <>
      <Button title="Summarise" onPress={() => streamResponse(notes)} />
      <Text>{streamedText}</Text>
    </>
  );
}
```

`streamResponse` is `undefined` until the model is ready, so the component shows why when it isn't: Apple Intelligence switched off, the model still downloading, or an ineligible device.

## Requirements

| | Requirement |
|---|---|
| iOS | iOS 26+ with Apple Intelligence enabled to generate. The module loads on iOS 16.4+ and reports `notEligible` below 26. The host project must target iOS 16.4+, and building needs Xcode 26.4 or newer. |
| Android | `minSdkVersion` 26+. Generation needs a Gemini Nano–capable device; most Android phones, including most mid-range ones, report `notEligible`. |
| Expo SDK | 52+ peer range. The example app targets SDK 58 / React Native 0.88; the peer range is not a tested compatibility matrix. |

A native development build is required, built locally or with EAS Build. Installing or upgrading the package needs a new binary; EAS Update cannot add native code. An iPhone simulator can run Foundation Models when the host Mac has Apple Intelligence enabled; latency and thermals still need real hardware.

If the project targets an iOS version below 16.4, the build fails with `module 'ExpoLocalLlm' has a minimum deployment target of iOS 16.4`. The 16.4 floor is for compilation only; generation still needs iOS 26.

For setup failures, unavailable models and unsupported features, see [troubleshooting](docs/troubleshooting.md).

### Xcode 27 requires scene support

Apps built with the iOS 27 SDK must adopt the UIKit scene lifecycle, or UIKit stops them at launch before any JavaScript runs. Expo SDK 58 apps adopt it by default, so there is nothing to set. Expo SDK 57 apps opt in through `expo-build-properties` (Expo `57.0.23`+, `expo-build-properties` `57.0.20`+):

```json
{
  "expo": {
    "plugins": [
      [
        "expo-build-properties",
        { "ios": { "deploymentTarget": "16.4", "enableSceneSupport": true } }
      ]
    ]
  }
}
```

Then regenerate and rebuild the native app. This is an app-level build setting, not something this library can enable for you.

## Usage

### Stream text in a component

```tsx
import { Text, View } from 'react-native';
import { useLocalLLM } from 'expo-local-llm';

function Chat() {
  const {
    availability,
    isGenerating,
    streamedText,
    error,
    respond,
    streamResponse,
    cancelStream,
    downloadModel,
    downloadProgress,
  } = useLocalLLM({
    instructions: 'You are a helpful assistant.',
  });

  // Methods become available after session creation and model readiness.
  if (!streamResponse) {
    return (
      <Text>
        {error ?? (availability === 'available'
          ? 'Preparing on-device AI...'
          : `On-device AI: ${availability}`)}
      </Text>
    );
  }

  const handleSend = async (prompt: string) => {
    // Streaming — updates streamedText live, resolves with the final text
    const text = await streamResponse(prompt);

    // Or non-streaming:
    // const response = await respond(prompt);
  };

  return (
    <View>
      <Text>Status: {availability}</Text>
      {isGenerating && <Text>{streamedText}</Text>}
    </View>
  );
}
```

### One-shot generation

For a single call with no conversation history, such as classifying or rewriting one message, use `generate()`. It creates a session, responds once and releases it:

```ts
import { generate } from 'expo-local-llm';

const title = await generate('Suggest a short title for this note: ...', {
  instructions: 'Reply with the title only.',
});
```

### Extract typed data (iOS)

`generateObject()` infers the result type from the schema, constrains the model's decoding to it, and validates the JSON before returning it:

```ts
import { generateObject, getCapabilities } from 'expo-local-llm';

if (getCapabilities().structuredOutputMode === 'constrained') {
  const result = await generateObject('Classify: "Can we move the meeting to Friday?"', {
    instructions: 'Classify the message by its primary intent.',
    schema: {
      intent: { type: 'string', enum: ['scheduling', 'question', 'other'] },
    },
  });
  // result.intent: 'scheduling' | 'question' | 'other'
}
```

A supported capability does not mean the model is ready, so handle rejected calls. A mismatch rejects with `StructuredOutputValidationError`; output is never repaired silently.

<p align="center">
  <img src="https://raw.githubusercontent.com/GijungKim/expo-local-llm/main/docs/structured-output.png" alt="Structured output demo — recipe JSON with constrained 'difficulty' enum on iPhone" width="320" />
</p>

*Real device output: the model fills in a recipe schema with `difficulty` constrained to `easy | medium | hard`. The streaming demo lives at `example/App.tsx`.*

### Structured output in the hook

In JSON mode the hook streams a partial object, then publishes the validated result:

```tsx
const { streamResponse, streamedObject, completedObject } = useLocalLLM({
  responseFormat: 'json',
  schema: {
    name: { type: 'string', description: 'Recipe name' },
    ingredients: { type: 'array', items: { type: 'string' } },
    difficulty: { type: 'string', enum: ['easy', 'medium', 'hard'] },
  },
});

await streamResponse?.('Give me a pasta recipe');
// streamedObject: fields appear as the model writes them (every field optional)
// completedObject: { name: string; ingredients: string[]; difficulty: 'easy' | 'medium' | 'hard' } | null
```

`respond` and `streamResponse` validate the final JSON and reject with `StructuredOutputValidationError` (`ERR_STRUCTURED_OUTPUT_INVALID`) if it does not match. A cancelled stream keeps its partial `streamedObject` and leaves `completedObject` null. `streamedJSON` holds the raw partial JSON.

Schemas are validated before they reach native code; a malformed one throws `SchemaInvalidError` with per-field paths. Call `validateSchema()` yourself when building schemas at runtime.

### Tool calling (iOS)

```tsx
import { Text, View } from 'react-native';
import { defineTool, useLocalLLM } from 'expo-local-llm';

const getWeather = defineTool({
  name: 'getWeather',
  description: 'Get the current weather for a city',
  parameters: {
    city: { type: 'string', description: 'The city name' },
    unit: { type: 'string', description: 'Temperature unit', enum: ['celsius', 'fahrenheit'] },
  },
  // Typed from `parameters`: city is a string, unit is 'celsius' | 'fahrenheit'.
  handler: async ({ city, unit }) => {
    const res = await fetch(
      `https://api.example.com/weather?city=${encodeURIComponent(city)}&unit=${unit}`
    );
    return JSON.stringify(await res.json());
  },
});

function WeatherChat() {
  const { streamResponse, streamedText, activeToolCalls, error } = useLocalLLM({
    instructions: 'You are a helpful weather assistant.',
    tools: [getWeather],
  });

  return (
    <View>
      {activeToolCalls.length > 0 && (
        <Text>Using {activeToolCalls.map((c) => c.toolName).join(', ')}...</Text>
      )}
      <Text>{streamedText}</Text>
    </View>
  );
}
```

`defineTool()` infers the handler's argument types from `parameters`; it returns the tool unchanged. Tools written inline in `tools` still work, with arguments typed as `Record<string, string | number | boolean>`.

Tool arguments use the same constrained decoding as structured output: the model fills in a schema built from `parameters`, so every declared parameter arrives with its declared type and any `enum` is respected. Validate values whose meaning matters (ranges, formats) as you would any input. If a handler throws or times out, the turn rejects with `ERR_TOOL_FAILED`.

### Handle errors

Generation failures and the library's own checks carry a stable `code` (see [Error codes](#error-codes)), so you can respond to *why* generation failed rather than parsing OS messages. The hook exposes it as `errorCode`; for a caught error, use `getLocalLLMErrorCode()`.

Foundation Models has a small context window, so a long conversation eventually fails with `ERR_CONTEXT_WINDOW_EXCEEDED`. On iOS the library never drops turns to make room (Android replays only the last 10 exchanges); decide what your app should do:

```tsx
const { errorCode, reset } = useLocalLLM({ instructions: 'You are a helpful assistant.' });

if (errorCode === 'ERR_CONTEXT_WINDOW_EXCEEDED') {
  // Start over, or create a new session seeded with a summary of the chat.
  reset?.();
}
if (errorCode === 'ERR_GUARDRAIL_VIOLATION' || errorCode === 'ERR_REFUSAL') {
  // The model declined; ask the person to rephrase.
}
```

```ts
import { generate, getLocalLLMErrorCode } from 'expo-local-llm';

try {
  await generate('Summarise my notes');
} catch (error) {
  if (error instanceof Error && getLocalLLMErrorCode(error) === 'ERR_RATE_LIMITED') {
    // The system is throttling on-device generation; retry later.
  }
}
```

#### Using with Effect

The library has no runtime dependencies, so it does not ship [Effect](https://effect.website) bindings. The error codes map directly onto a tagged error, so a wrapper takes a few lines:

```ts
import { Data, Effect } from 'effect';
import { generate, getLocalLLMErrorCode, type LocalLLMErrorCode } from 'expo-local-llm';

class LocalLLMFailure extends Data.TaggedError('LocalLLMFailure')<{
  code: LocalLLMErrorCode | null;
  message: string;
}> {}

const generateEffect = (prompt: string) =>
  Effect.tryPromise({
    try: () => generate(prompt),
    catch: (error) =>
      new LocalLLMFailure({
        code: error instanceof Error ? getLocalLLMErrorCode(error) : null,
        message: error instanceof Error ? error.message : 'Generation failed',
      }),
  });

// Recover from one failure by its code.
const answer = generateEffect('Summarise my notes').pipe(
  Effect.catchIf(
    (failure) => failure.code === 'ERR_RATE_LIMITED',
    () => Effect.succeed('Try again in a moment.'),
  ),
);
```

## API reference

### `getCapabilities()`

Reports which features the loaded platform integration implements. Use this to decide whether to offer text, streaming, tools, or structured output. Check model availability separately before starting generation. A supported capability does not mean the OS model is currently ready.

The function does not download models, start inference, or opt the app into a cloud service.

Returns `platform`, `backend`, `status`, boolean `text`/`streaming`/`tools`/`structuredOutput` flags, `structuredOutputMode` (`'constrained'` or `'unsupported'`), and `experimental`. `experimental` is `true` on Android until Gemini Nano generation has been validated on real hardware; gate production features on it if you need verified behavior.

Capability `status` is `'available'`, `'moduleUnavailable'`, `'unsupportedOS'`, or `'unsupportedPlatform'`. Here `'available'` means the integration is supported; use the hook's `availability` for current model readiness.

### `getModuleDiagnostics()`

Reports whether native code loaded, with `available`, `reason`, `message`, and `setupInstructions`. A missing module is a build/setup problem, distinct from a device that cannot run the model.

```ts
import { getModuleDiagnostics } from 'expo-local-llm';

const diagnostics = getModuleDiagnostics();
if (!diagnostics.available) {
  console.warn(diagnostics.message);
}
```

### `useLocalLLM(options?)`

#### Options

| Option | Type | Description |
|--------|------|-------------|
| `instructions` | `string` | System instructions for the session |
| `options.temperature` | `number` | Sampling temperature |
| `options.maxTokens` | `number` | Max output tokens (`maxOutputTokens` on Android; `maximumResponseTokens` on iOS). Native SDK/model limits apply. |
| `options.topK` | `number` | Top-K sampling (maps to `.random(top:)` on iOS) |
| `tools` | `ToolDefinition[]` | Tools the model can invoke (iOS 26+ only) |
| `toolTimeout` | `number` | Seconds before an unresolved tool call times out (default 30) |
| `responseFormat` | `"text" \| "json"` | Set to `"json"` for structured JSON output; requires `schema` |
| `schema` | `Schema` | Schema for structured output (used with `responseFormat: "json"`); see [Structured output in the hook](#structured-output-in-the-hook) |
| `includeSchemaInPrompt` | `boolean` | iOS 26+: include the schema definition in the prompt. Default `true`. Set `false` when you've front-loaded few-shot examples. |

#### Returns

| Property | Type | Description |
|----------|------|-------------|
| `availability` | `ModelAvailability` | Current model status |
| `isGenerating` | `boolean` | Whether a generation is in progress |
| `streamedText` | `string` | Accumulated text from current text stream |
| `streamedJSON` | `string` | Current partial JSON from a schema-driven stream |
| `streamedObject` | `DeepPartial<InferSchema<schema>> \| null` | Parsed value of `streamedJSON` (or `null` before any partial). Fields may be missing until generated. |
| `completedObject` | `InferSchema<schema> \| null` | The finished JSON-mode response, validated against the schema. `null` while generating and after a cancel. |
| `downloadProgress` | `number \| null` | Download progress 0-1 (Android only) |
| `error` | `string \| null` | Last error message |
| `errorCode` | `LocalLLMErrorCode \| null` | Code of the last error (see [Error codes](#error-codes)); `null` when there is none or it came from your own code |
| `activeToolCalls` | `ActiveToolCall[]` | In-flight tool calls (`{ callId, toolName }`) |
| `respond` | `(prompt: string) => Promise<string>` | Non-streaming generation. `undefined` when unavailable. |
| `session` | `LLMSession \| null` | The native session object. `null` before creation or when unavailable. Use the hook's generation methods for hook-managed state and tool dispatch. |
| `streamResponse` | `(prompt: string) => Promise<string>` | Streaming generation (updates `streamedText`). Resolves with the final text at stream end, or the partial text if cancelled; rejects on stream failure. `undefined` when model not `available`. |
| `cancelStream` | `() => Promise<void>` | Cancel the active stream; the pending `streamResponse` promise resolves with the partial text. Available whenever a session exists, even if model readiness changes. |
| `reset` | `() => void` | Clear the conversation transcript, keeping instructions/tools/schema/options. Also cancels any in-flight stream. `undefined` only when there is no session. |
| `downloadModel` | `() => Promise<void>` | Trigger model download (Android). `undefined` when unavailable. |

### `generate(prompt, config?)`

One-shot stateless generation — creates a session, responds once, and releases it. Takes the
same generation config as `useLocalLLM`/`createLLMSession`, except tool handlers are not supported. Use it for classification or extraction
calls where conversation history between calls is unwanted. Throws when the module or model
is unavailable (check `ExpoLocalLlmModule.getAvailability()` first if you need to gate).

Use `useLocalLLM()` for automatic tool dispatch. Low-level `createLLMSession()` consumers must subscribe to `toolCall` and resolve or reject each call themselves; passing handlers in its configuration does not install those listeners.

### `generateObject(prompt, config)`

One-shot structured generation with a required `schema`. Returns an object whose type is inferred from the schema, after validating every required field, primitive type, enum, array item, and nested object. Unexpected properties are rejected. Use inline schema literals or `as const satisfies Schema` to preserve enum literal types.

This helper requires constrained structured output support (currently iOS 26+). It releases its session on success and failure. Generation errors and model refusals still reject the call; schema validation establishes structure, not factual accuracy.

`validateStructuredOutput(value, schema)` is also available for checking an already-parsed value against a valid schema. It returns `{ ok: true }` or `{ ok: false, errors }` with field paths.

### `createLLMSession(config?)`

Creates a manually owned conversation. Release it when finished:

```ts
import { createLLMSession } from 'expo-local-llm';

const session = createLLMSession({ instructions: 'Keep answers concise.' });
try {
  const text = await session.respond('Suggest a short title for a gardening journal.');
} finally {
  session.release();
}
```

Low-level `respond(prompt, requestId?)` and `streamResponse(prompt, requestId?)` accept an optional request identifier. Generation events carry `requestId` so consumers can discard queued events from cancelled or reset requests. Omit it to let native code generate an identifier; `useLocalLLM()` manages identifiers and filtering automatically. Use a distinct identifier for each invocation.

### Error codes

Errors thrown or rejected by the library, and `streamError` events, carry one of these codes. Messages come from the OS and may change; codes do not.

On iOS 27, Foundation Models reports some failures with error types that only the iOS 27 SDK can name. Build with Xcode 27 to classify all of them. An app built with Xcode 26.4 still gets codes for the iOS 26 error types, but reports the newer ones as `ERR_GENERATION_FAILED`.

| Code | Meaning |
|------|---------|
| `ERR_CONTEXT_WINDOW_EXCEEDED` | The conversation no longer fits the model's context window. Reset or start a new session. |
| `ERR_GUARDRAIL_VIOLATION` | Safety guardrails blocked the prompt or response. |
| `ERR_REFUSAL` | The model declined to answer. |
| `ERR_UNSUPPORTED_LANGUAGE` | The prompt language or device locale is not supported. |
| `ERR_UNSUPPORTED_REQUEST` | The request uses a capability the model or helper cannot honour. |
| `ERR_RATE_LIMITED` | The system is throttling generation (quota, background use, load). Retry later. |
| `ERR_MODEL_UNAVAILABLE` | Model assets are missing or the device cannot run the model right now. |
| `ERR_DECODING_FAILED` | Output could not be decoded into the requested structure. |
| `ERR_TIMEOUT` | Generation exceeded the system's time limit (iOS 27+). |
| `ERR_TOOL_FAILED` | A tool handler threw or timed out, or the hook had no handler for the tool. |
| `ERR_GENERATION_FAILED` | Any other generation failure. |
| `ERR_SESSION_BUSY` | The session already has a generation in progress. |
| `ERR_SESSION_INVALID` | The session was released or is not ready. |
| `ERR_NOT_SUPPORTED` | On-device generation is not available on this OS version. |
| `ERR_RESPONSE_FORMAT_NOT_SUPPORTED` | Structured output is not supported on this platform. |
| `ERR_TOOL_NOT_SUPPORTED` | Tool calling is not supported on this platform. |
| `ERR_MODEL_DOWNLOAD_FAILED` | Android: downloading Gemini Nano failed. |
| `ERR_SCHEMA_INVALID` | A schema is malformed (`SchemaInvalidError`). |
| `ERR_STRUCTURED_OUTPUT_INVALID` | Generated JSON did not match the schema (`StructuredOutputValidationError`). |
| `ERR_UNAVAILABLE` | The native module is missing from this build. |

### `ModelAvailability`

`'available' | 'notEnabled' | 'notReady' | 'notEligible' | 'downloadRequired' | 'downloading' | 'unknown' | 'moduleUnavailable'`

Android readiness is checked asynchronously and may initially be `unknown`. Prefer `useLocalLLM()` for reactive readiness; low-level consumers should listen for the module's `availabilityChange` event instead of treating the first synchronous status read as final.

### `validateSchema(schema)` and `validateStructuredOutput(value, schema)`

`validateSchema` checks a schema and returns `{ ok: true }` or `{ ok: false, errors }` with field paths (missing `items`, `enum` on the wrong type, unknown `type`). `validateStructuredOutput` checks an already-parsed value against a valid schema the same way.

## Platform differences and limitations

| Concern | iOS | Android |
|---|---|---|
| System instructions | Native `LanguageModelSession(instructions:)` | Prepended to the prompt |
| Conversation history | Kept by the native session | Replayed in the prompt: the last 10 exchanges, with role markers in conversation text neutralised |
| Model availability | Built into the OS | May need `downloadModel()` |
| Token limits | OS and model dependent | SDK and model dependent |

- **Context window.** Neither platform trims history to fit the model's context; Android only caps it at 10 exchanges. iOS rejects with `ERR_CONTEXT_WINDOW_EXCEEDED`; call `reset()` or start a new session.
- **One generation per session.** Overlapping requests reject with `ERR_SESSION_BUSY`. After cancelling, await the original promise before starting another request. Use separate sessions for independent conversations; events belong to their session.
- **Guardrails.** Apple's model refuses some categories of prompt, such as interpreting personal health data. A refusal arrives as `ERR_GUARDRAIL_VIOLATION` or `ERR_REFUSAL`.
- **Android is experimental.** The Gemini Nano SDK is in beta and its API may change. Structured output and tools are rejected at session creation.
- **Readiness gates generation.** `respond` and `streamResponse` need a session and `availability === 'available'`; cancelling and resetting work whenever a session exists.

## How this library is verified

- **Every pull request:** lint, unit tests, type-level tests, and a compile of a freshly generated Expo SDK 58 app on both platforms, with the iOS build using Xcode 26.4, the oldest supported toolchain. Android also runs JVM tests of the prompt assembly and error mapping.
- **Against the real model:** [`tools/model-check`](tools/model-check/README.md) runs the library's Foundation Models code on a Mac with Apple Intelligence: constrained tool arguments, error-code mapping and schema-constrained output. The release checklist runs it before each release.
- **On devices:** the [release verification record](docs/release-verification.md) lists what has been checked on an iPhone 15 Pro, a simulator and a Galaxy A17, and leaves untested scenarios marked as pending rather than assumed.

## Choosing this library

Choose `expo-local-llm` for a small, Expo-first API around system-provided language models: short text generation, classification, extraction, and streaming interfaces on supported devices. You do not select or distribute model weights.

If you need downloadable models, embeddings, speech, or an AI SDK provider interface, evaluate a broader runtime such as [React Native AI](https://github.com/callstackincubator/ai). Check its current provider documentation for platform requirements. This library does not implement those capabilities or automatically route requests to a cloud model.

### Why an Expo module?

The [Expo Modules API](https://docs.expo.dev/modules/overview/) fits OS-provided AI APIs well:

- **Native session objects** — Expo's `SharedObject` and class DSL expose instance methods and session-scoped events directly to JavaScript.
- **Lifecycle integration** — native cleanup hooks support cancellation and resource release. `generate()` releases its session automatically; consumers of `createLLMSession()` must call `release()` when finished.
- **Swift and Kotlin** — both implementations use a consistent module definition style, without adding a separate inference engine.
- **Expo build workflows** — autolinking integrates with prebuild, local development builds, and EAS Build.

Expo does not improve model quality or remove device eligibility requirements. Its native-call performance is comparable to React Native Turbo Modules; autolinking is not unique to Expo. The benefit is a cohesive integration and maintenance experience.

Existing React Native apps can use this library after [installing Expo Modules support](https://docs.expo.dev/bare/installing-expo-modules/). Expo-first does not mean Expo-only.

## Used by

- [Angular Native](https://github.com/ng-native/ng-native): wraps it as the `LanguageModel` service in `@ng-native/expo`
- [PulseID](https://apps.apple.com/us/app/pulseid-heart-rate-camera/id6754331991): heart rate camera
- [Teamfit Tactics](https://apps.apple.com/us/app/teamfit-tactics-tft-fitness/id6757195493): TFT fitness

*Using this library? Open a PR to add your app.*

## License

MIT
