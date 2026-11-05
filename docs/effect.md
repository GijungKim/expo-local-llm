# Using with Effect

[Back to error handling](../README.md#handle-errors)

The library has no additional npm runtime dependencies, so it does not ship [Effect](https://effect.website) bindings. The error codes map directly onto a tagged error, so a wrapper takes a few lines:

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
