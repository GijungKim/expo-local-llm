# expo-local-llm

Expo module for on-device LLM inference. Wraps Apple Foundation Models (iOS 26+) and Gemini Nano via ML Kit (Android).

## Platform Requirements

| Platform | Requirement |
|----------|-------------|
| iOS | iOS 26+ with Apple Intelligence enabled. Loads on iOS 16+ without crashing (returns `notEligible`). Host project must target iOS 16.0+. |
| Android | Device with Gemini Nano support (Pixel 8+, Galaxy S25+). Model may require download. |

## Installation

```bash
npm install expo-local-llm
npx expo prebuild
```

## Usage

```tsx
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

  // Methods are undefined when module is unavailable (optionality pattern)
  if (!streamResponse) {
    return <Text>On-device LLM not available</Text>;
  }

  const handleSend = async (prompt: string) => {
    // Streaming — updates streamedText live
    await streamResponse(prompt);

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

### Tool Calling (iOS 26+)

```tsx
import { useLocalLLM } from 'expo-local-llm';

function WeatherChat() {
  const { streamResponse, streamedText, activeToolCalls, error } = useLocalLLM({
    instructions: 'You are a helpful weather assistant.',
    tools: [
      {
        name: 'getWeather',
        description: 'Get the current weather for a city',
        parameters: {
          city: { type: 'string', description: 'The city name' },
        },
        handler: async (args) => {
          const res = await fetch(`https://api.example.com/weather?city=${args.city}`);
          return JSON.stringify(await res.json());
        },
      },
    ],
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

### Structured Output

```tsx
const { respond } = useLocalLLM({
  responseFormat: 'json',
  schema: {
    name: { type: 'string', description: 'Recipe name' },
    ingredients: { type: 'array', description: 'List of ingredients' },
    steps: { type: 'array', description: 'Cooking steps' },
  },
});

const recipe = JSON.parse(await respond('Give me a pasta recipe'));
```

## API

### `useLocalLLM(options?)`

#### Options

| Option | Type | Description |
|--------|------|-------------|
| `instructions` | `string` | System instructions for the session |
| `options.temperature` | `number` | Sampling temperature |
| `options.maxTokens` | `number` | Max output tokens (capped at 256 on Android) |
| `options.topK` | `number` | Top-K sampling |
| `tools` | `ToolDefinition[]` | Tools the model can invoke (iOS 26+ only) |
| `toolTimeout` | `number` | Seconds before an unresolved tool call times out (default 30) |
| `responseFormat` | `"text" \| "json"` | Set to `"json"` for structured JSON output |
| `schema` | `Record<string, any>` | JSON schema for structured output (used with `responseFormat: "json"`) |

#### Returns

| Property | Type | Description |
|----------|------|-------------|
| `availability` | `ModelAvailability` | Current model status |
| `isGenerating` | `boolean` | Whether a generation is in progress |
| `streamedText` | `string` | Accumulated text from current stream |
| `downloadProgress` | `number \| null` | Download progress 0-1 (Android only) |
| `error` | `string \| null` | Last error message |
| `activeToolCalls` | `ActiveToolCall[]` | In-flight tool calls (`{ callId, toolName }`) |
| `respond` | `(prompt: string) => Promise<string>` | Non-streaming generation. `undefined` when unavailable. |
| `session` | `LLMSession \| null` | The native session object. `null` when unavailable. |
| `streamResponse` | `(prompt: string) => Promise<void>` | Streaming generation (updates `streamedText`). `undefined` when model not `available`. |
| `cancelStream` | `() => Promise<void>` | Cancel active stream. `undefined` when unavailable. |
| `downloadModel` | `() => Promise<void>` | Trigger model download (Android). `undefined` when unavailable. |

### `ModelAvailability`

`'available' | 'notEnabled' | 'notReady' | 'notEligible' | 'downloadRequired' | 'downloading' | 'unknown'`

## Platform Asymmetries

| Concern | iOS | Android |
|---------|-----|---------|
| System instructions | Native `LanguageModelSession(instructions:)` | Prepended in prompt text |
| Output tokens | ~4K context, generous output | 256 max |
| Model availability | Built-in to OS | May need download |
| Session history | Native session maintains it | `ConversationHistory` class |
| Streaming | `AsyncSequence` | Kotlin `Flow` |

## Known Limitations

- Only one active stream at a time. Events are not scoped to session ID.
- **Android**: Gemini Nano SDK is in beta. API surface may change — not yet validated on device.
- **iOS**: Apple's Foundation Model may refuse certain categories of prompts (e.g. personal health data interpretation) due to built-in safety guardrails.
- Methods (`respond`, `streamResponse`, `cancelStream`) are only defined when `availability === 'available'`.
- Tool calling is iOS 26+ only. Android will throw at session creation if tools are passed.
- Structured output uses instruction-based JSON guidance, not Apple's constrained decoding.

## Why an Expo module?

This is built as an [Expo Module](https://docs.expo.dev/modules/overview/), not
a bare React Native library. Here's why:

- **`expo install` and go** — no manual Xcode/Gradle linking, no `pod install`
  surprises. Works with `npx expo prebuild` and managed workflow out of the box.
- **SharedObject lifecycle** — `LLMSession` extends Expo's `SharedObject`, which
  handles native memory management, event subscriptions, and cleanup
  automatically when the JS object is garbage collected. In bare RN you'd wire
  this yourself with `NativeEventEmitter` and manual release calls.
- **Class DSL** — the native module exposes `LLMSession` as a first-class JS
  object with instance methods (`session.respond()`, `session.streamResponse()`)
  rather than flat module-level functions with session IDs. This is an Expo
  Modules API feature that doesn't exist in the classic RN bridge.
- **Cross-platform parity** — Expo's Kotlin DSL mirrors the Swift DSL, so the
  iOS and Android modules have the same structure. Adding Android tool calling
  later means implementing the same interface, not building a separate bridge.

If you're on bare React Native without Expo, this module won't work — you'd need
to add `expo-modules-core` as a dependency or use a different library.

## How is this different from @callstack/ai? (as of March 2026)

[@callstack/ai](https://github.com/callstackincubator/ai) is a full-featured
framework that supports multiple on-device backends (Apple Foundation Models,
Llama/GGUF, MLC) with Vercel AI SDK integration, generative UI, and DevTools.

`expo-local-llm` takes a different approach:

| | `expo-local-llm` | `@callstack/ai` |
|---|---|---|
| **Philosophy** | Thin bridge to the OS-provided model | Multi-backend AI framework |
| **iOS model** | Apple Foundation Models (system-provided) | Apple Foundation Models, Llama, MLC |
| **Android model** | Gemini Nano (system-provided) | No Android support |
| **Model management** | None — the OS handles it | You configure/download models |
| **Bundle size impact** | Near zero | Depends on backend + model weights |
| **Tool calling** | Yes (iOS 26+) | Yes |
| **Structured output** | Yes (instruction-based) | Yes |
| **Expo native module** | Yes — `expo install` and go | Bare React Native setup |
| **Dependencies** | None | Vercel AI SDK, Jotai, backend runtimes |

**Choose `expo-local-llm` if** you want the simplest path to on-device LLM in
an Expo app and are happy using whatever model the OS provides. There's nothing
to configure, no weights to bundle, and it works on both iOS and Android.

**Choose `@callstack/ai` if** you need to pick specific models (Llama 3.2,
Phi-3, Mistral), want Vercel AI SDK compatibility, or need the generative UI
and DevTools ecosystem.

## Built with expo-local-llm

- [PulseID](https://apps.apple.com/us/app/pulseid-heart-rate-camera/id6754331991) — Heart rate camera
- [Teamfit Tactics](https://apps.apple.com/us/app/teamfit-tactics-tft-fitness/id6757195493) — TFT fitness

*Using this library? Open a PR to add your app.*

## License

MIT
