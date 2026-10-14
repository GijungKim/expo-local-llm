# expo-local-llm

On-device intelligence for Expo apps, using the models provided by the operating system. Generate text, extract structured data, and build streaming interfaces without distributing model weights or writing native code.

Wraps Apple Foundation Models (iOS 26+) and Gemini Nano (Android). Inference stays on device; any network access inside your tool handlers is controlled by your app. There is no automatic cloud fallback.

## Platform Requirements

| Platform | Requirement |
|----------|-------------|
| iOS | iOS 26+ with Apple Intelligence enabled. Loads on iOS 16.4+ without crashing (returns `notEligible`). Host project must target iOS 16.4+. |
| Android | Host app uses `minSdkVersion` 26+. Inference requires a Gemini Nano–capable device; most Android devices, including most mid-range phones, report `notEligible`. Build, module loading, eligibility, and unsupported-feature handling are device-verified; generation is not yet validated on Gemini Nano hardware, so `getCapabilities()` reports Android as `experimental: true`. |
| Expo SDK | 52+ (peer range); the example targets SDK 57 / React Native 0.86. A peer range is not a tested compatibility matrix. |

**A native development build is required. Stock Expo Go cannot load this module.** A simulator can compile the module and, when the host Mac has Apple Intelligence enabled and ready, run Apple Foundation Models for real inference; physical hardware is still needed for latency and thermal measurements. See the [release verification matrix](docs/release-verification.md).

For setup failures, unavailable models, and unsupported features, see [troubleshooting](docs/troubleshooting.md).

### Xcode 27 requires scene support

Apps built with the iOS 27 SDK must adopt the UIKit scene lifecycle, or UIKit stops them at launch before any JavaScript runs. Expo SDK 57 apps opt in through `expo-build-properties` (Expo `57.0.23`+, `expo-build-properties` `57.0.20`+):

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

## Installation

```bash
npx expo install expo-local-llm expo-dev-client
```

This module requires **iOS 16.4+** and **Android API 26+** deployment targets. If your app targets an earlier version, raise the relevant target via [`expo-build-properties`](https://docs.expo.dev/versions/latest/sdk/build-properties/):

```bash
npx expo install expo-build-properties
```

In `app.json`, add the plugin with the deployment target:

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

Build and install your development app on a supported physical device:

```bash
npx expo run:ios --device
# or
npx expo run:android --device
```

> If your project targets an iOS version below 16.4, you'll hit `compiling for iOS X.Y, but module 'ExpoLocalLlm' has a minimum deployment target of iOS 16.4` at build time. (Apple Intelligence itself still requires iOS 26+ at runtime — the 16.4 floor is just for compilation; the module returns `notEligible` on iOS 16.4–25.)

The iOS native build requires an Xcode SDK containing Foundation Models; the SDK 57 example requires Xcode 26.4 or newer. `expo run` generates native projects if they do not exist. For projects using Continuous Native Generation, regenerate and rebuild after changing native dependencies or native app configuration. Keep custom native changes in config plugins before using `prebuild --clean`.

EAS Build is also supported as a build workflow: use a development profile with a compatible native toolchain. Installing this package or upgrading its native implementation requires a new binary; EAS Update cannot add native code. JavaScript-only changes can use the existing binary when they remain compatible with its native API.

## Usage

### Extract typed data (iOS 26+)

For classification and extraction, use `generateObject()`. It infers the result type from your schema and validates the generated JSON before returning it:

```ts
import { generateObject, getCapabilities } from 'expo-local-llm';

const capabilities = getCapabilities();
// Capability support and current model readiness are separate checks.
if (capabilities.structuredOutputMode === 'constrained') {
  const result = await generateObject('Classify: "Can we move the meeting to Friday?"', {
    instructions: 'Classify the message by its primary intent.',
    schema: {
      intent: { type: 'string', enum: ['scheduling', 'question', 'other'] },
    },
  });
  // result.intent: 'scheduling' | 'question' | 'other'
}
```

Handle rejected requests in your app: supported capabilities do not imply that the model is downloaded, enabled, or ready. `generateObject()` rejects invalid JSON or schema mismatches with `StructuredOutputValidationError`; it never repairs output silently or falls back to cloud inference.

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

### Handle errors

Every error from this library carries a stable `code` (see [Error codes](#error-codes)), so you can respond to *why* generation failed rather than parsing OS messages. The hook exposes it as `errorCode`; for a caught error, use `getLocalLLMErrorCode()`.

Foundation Models has a small context window, so a long conversation eventually fails with `ERR_CONTEXT_WINDOW_EXCEEDED`. The library never drops turns silently; decide what your app should do:

```tsx
const { errorCode, reset, streamResponse } = useLocalLLM({ instructions });

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
  await generate(prompt);
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

### Tool Calling (iOS 26+)

```tsx
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

### Structured Output

iOS 26+ uses Apple's constrained decoding (`DynamicGenerationSchema`) for schema-driven output.
Successful generation produces structured JSON; requests can still fail or be refused.
Android structured output is unsupported and rejected explicitly, rather than silently generating ordinary text.

<p align="center">
  <img src="https://raw.githubusercontent.com/GijungKim/expo-local-llm/main/docs/structured-output.png" alt="Structured output demo — recipe JSON with constrained 'difficulty' enum on iPhone" width="320" />
</p>

*Real device output: the model fills in a recipe schema with `difficulty` constrained to `easy | medium | hard`. The streaming demo lives at `example/App.tsx`.*

```tsx
const { respond, completedObject } = useLocalLLM({
  responseFormat: 'json',
  schema: {
    name: { type: 'string', description: 'Recipe name' },
    ingredients: {
      type: 'array',
      items: { type: 'string' },
      description: 'List of ingredients',
    },
    steps: {
      type: 'array',
      items: { type: 'string' },
      description: 'Cooking steps',
    },
    difficulty: {
      type: 'string',
      enum: ['easy', 'medium', 'hard'],
    },
  },
});

if (respond) {
  await respond('Give me a pasta recipe');
}
// completedObject is typed from the schema and validated against it:
// { name: string; ingredients: string[]; steps: string[]; difficulty: 'easy' | 'medium' | 'hard' } | null
```

In JSON mode, `respond` and `streamResponse` validate the final JSON against the schema and reject with `StructuredOutputValidationError` (`ERR_STRUCTURED_OUTPUT_INVALID`) if it does not match.

For one-shot structured calls (classification, extraction) where you don't want conversation
history accumulating between calls, use `generate()` instead of a session:

```ts
import { generate } from 'expo-local-llm';

const json = await generate('Classify this message: "how was my sleep?"', {
  instructions: 'Classify what the message asks for.',
  responseFormat: 'json',
  schema: { topic: { type: 'string', enum: ['sleep', 'heart', 'none'] } },
});
```

Streaming with a schema yields progressively-filled snapshots via `streamedJSON` (the current
partial as a JSON string) and `streamedObject` (the parsed value, typed with every field optional).
When the stream completes, the validated result lands in `completedObject`:

```tsx
const { streamResponse, streamedObject, completedObject } = useLocalLLM({
  responseFormat: 'json',
  schema: { /* ... */ },
});

await streamResponse?.('Give me a pasta recipe');
// streamedObject updates as the model fills in fields;
// completedObject is set once the whole object has validated.
```

A cancelled stream keeps its partial `streamedObject` and leaves `completedObject` null.

#### Schema validation

`createLLMSession` validates the schema before crossing to native and throws `SchemaInvalidError`
with per-field paths if anything is malformed (missing `items`, `enum` on the wrong type, unknown
`type`, etc.). You can also call `validateSchema()` directly when building schemas at runtime:

```ts
import { validateSchema } from 'expo-local-llm';

const result = validateSchema(mySchema);
if (!result.ok) {
  for (const err of result.errors) {
    console.warn(`${err.path}: ${err.message}`);
  }
}
```

## API

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
| `schema` | `Schema` | Schema for structured output (used with `responseFormat: "json"`) — see Structured Output section |
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
| `ERR_TOOL_FAILED` | A tool handler threw, timed out, or was removed mid-call. |
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

## Platform Asymmetries

| Concern | iOS | Android |
|---------|-----|---------|
| System instructions | Native `LanguageModelSession(instructions:)` | Prepended in prompt text |
| Token limits | OS/model-dependent | SDK/model-dependent |
| Model availability | Built-in to OS | May need download |
| Session history | Native session maintains it | Replayed in the prompt; last 10 exchanges, with role markers in conversation text neutralised |
| Streaming | `AsyncSequence` | Kotlin `Flow` |

## Known Limitations

- Events belong to their session. Use a separate session for independent conversations.
- A session accepts one generation at a time; overlapping requests reject. After cancellation, await the original generation promise before starting another request.
- **Android**: Gemini Nano SDK is in beta and its API surface may change. Build, module loading, eligibility, and unsupported-feature rejection are device-verified; generation has not been validated on Gemini Nano hardware (`getCapabilities().experimental` is `true`).
- **Context window**: neither platform trims history to fit the model's context. iOS rejects with `ERR_CONTEXT_WINDOW_EXCEEDED` when the transcript is too long; Android keeps the last 10 exchanges. Call `reset()` or start a new session when that happens.
- **iOS**: Apple's Foundation Model may refuse certain categories of prompts (e.g. personal health data interpretation) due to built-in safety guardrails.
- Generation methods (`respond`, `streamResponse`) require a session and `availability === 'available'`. Cancellation remains available while a session exists.
- Tool calling is iOS 26+ only. Android will throw at session creation if tools are passed.
- Structured output on Android is unsupported. iOS 26+ uses constrained decoding via `DynamicGenerationSchema`.

## Why an Expo module?

The [Expo Modules API](https://docs.expo.dev/modules/overview/) fits OS-provided AI APIs well:

- **Native session objects** — Expo's `SharedObject` and class DSL expose instance methods and session-scoped events directly to JavaScript.
- **Lifecycle integration** — native cleanup hooks support cancellation and resource release. `generate()` releases its session automatically; consumers of `createLLMSession()` must call `release()` when finished.
- **Swift and Kotlin** — both implementations use a consistent module definition style, without adding a separate inference engine.
- **Expo build workflows** — autolinking integrates with prebuild, local development builds, and EAS Build.

Expo does not improve model quality or remove device eligibility requirements. Its native-call performance is comparable to React Native Turbo Modules; autolinking is not unique to Expo. The benefit is a cohesive integration and maintenance experience.

Existing React Native apps can use this library after [installing Expo Modules support](https://docs.expo.dev/bare/installing-expo-modules/). Expo-first does not mean Expo-only.

## Choosing this library

Choose `expo-local-llm` for a small, Expo-first API around system-provided language models: short text generation, classification, extraction, and streaming interfaces on supported devices. You do not select or distribute model weights.

If you need downloadable models, embeddings, speech, or an AI SDK provider interface, evaluate a broader runtime such as [React Native AI](https://github.com/callstackincubator/ai). Check its current provider documentation for platform requirements. This library does not implement those capabilities or automatically route requests to a cloud model.

## Built with expo-local-llm

- [PulseID](https://apps.apple.com/us/app/pulseid-heart-rate-camera/id6754331991) — Heart rate camera
- [Teamfit Tactics](https://apps.apple.com/us/app/teamfit-tactics-tft-fitness/id6757195493) — TFT fitness

*Using this library? Open a PR to add your app.*

## License

MIT
