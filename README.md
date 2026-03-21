# expo-local-llm

Expo module for on-device LLM inference. Wraps Apple Foundation Models (iOS 26+) and Gemini Nano via ML Kit (Android).

## Platform Requirements

| Platform | Requirement |
|----------|-------------|
| iOS | iOS 26+ with Apple Intelligence enabled. Loads on iOS 16+ without crashing (returns `notEligible`). |
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

## API

### `useLocalLLM(options?)`

#### Options

| Option | Type | Description |
|--------|------|-------------|
| `instructions` | `string` | System instructions for the session |
| `options.temperature` | `number` | Sampling temperature |
| `options.maxTokens` | `number` | Max output tokens (capped at 256 on Android) |
| `options.topK` | `number` | Top-K sampling |

#### Returns

| Property | Type | Description |
|----------|------|-------------|
| `availability` | `ModelAvailability` | Current model status |
| `isGenerating` | `boolean` | Whether a generation is in progress |
| `streamedText` | `string` | Accumulated text from current stream |
| `downloadProgress` | `number \| null` | Download progress 0-1 (Android only) |
| `error` | `string \| null` | Last error message |
| `respond` | `(prompt: string) => Promise<string>` | Non-streaming generation. `undefined` when unavailable. |
| `streamResponse` | `(prompt: string) => Promise<void>` | Streaming generation (updates `streamedText`). `undefined` when unavailable. |
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

- **v0.1.0**: Only one active stream at a time. Events are not scoped to session ID.
- **Android**: Gemini Nano SDK is in beta. API surface may change.
- No tool calling or structured output yet.

## License

MIT
