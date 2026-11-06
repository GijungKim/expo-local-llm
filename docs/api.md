# API reference

[Back to the README](../README.md) · [Troubleshooting](troubleshooting.md)

For runnable examples, start with [usage](../README.md#usage). This reference describes the 0.10.0 API.

## `getCapabilities()`

Reports which features the loaded platform integration implements. Use this to decide whether to offer text, streaming, tools, or structured output. Check model availability separately before starting generation. A supported capability does not mean the OS model is currently ready. The `images` field additionally checks current model readiness and vision support on iOS; Android reports cached readiness and cannot promise that the device model understands images. On Android, this call reads cached availability and starts an asynchronous refresh that emits `availabilityChange`.

The function does not download models, start inference, or opt the app into a cloud service.

Returns `platform`, `backend`, `status`, boolean `text`/`streaming`/`tools`/`structuredOutput` flags, `images` (`'supported'` on a ready, vision-capable iOS backend, `'unknown'` when a current Android bridge's cached availability is `'available'`, `'unsupported'` otherwise), `structuredOutputMode` (`'constrained'` or `'unsupported'`), `objectGenerationMode` (`'constrained'`, `'validated'`, or `'unsupported'`), and `experimental`. `objectGenerationMode` is the path selected by default `generateObject()` calls; `structuredOutputMode` remains native-only. `experimental` is an integration maturity flag, retained for compatibility, and is `false` on both platforms as of 0.10.0. It does not certify hardware verification; see the [verification record](release-verification.md) for device-test evidence.

Capability `status` is `'available'`, `'moduleUnavailable'`, `'unsupportedOS'`, or `'unsupportedPlatform'`. Here `'available'` means the integration is supported; use the hook's `availability` for current model readiness.

## `getModelReadiness(androidModel?: AndroidModel)`

Returns a promise of `{ availability, tools: 'available' | 'unavailable' | 'unknown' }`. Android queries `checkStatus()` and `getAvailableFeatures()` on the selected client; query failures are `unknown`. Feature support and model availability are separate: a downloadable model may advertise tools but cannot yet generate. The hook's readiness/download paths follow its `androidModel` option, and Android module events include `androidModel`. Direct module `getAvailability(androidModel?)` and `downloadModel(androidModel?)` accept the same selection.

`getCapabilities().tools` reports integration support, not device readiness. Older Android binaries without `getToolCallingVersion() === 1` report no tool support. Explicit preview selection fails clearly on those binaries instead of querying or downloading the default model. Rebuild after upgrading native code; an OTA JS update cannot add this support.

## `getModuleDiagnostics()`

Reports whether native code loaded, with `available`, `reason`, `message`, and `setupInstructions`. A missing module is a build/setup problem, distinct from a device that cannot run the model.

```ts
import { getModuleDiagnostics } from 'expo-local-llm';

const diagnostics = getModuleDiagnostics();
if (!diagnostics.available) {
  console.warn(diagnostics.message);
}
```

## `useLocalLLM(options?)`

### Options

| Option | Type | Description |
|--------|------|-------------|
| `instructions` | `string` | System instructions for the session |
| `options.temperature` | `number` | Sampling temperature |
| `options.maxTokens` | `number` | Max output tokens (`maxOutputTokens` on Android; `maximumResponseTokens` on iOS). Native SDK/model limits apply. |
| `options.topK` | `number` | Top-K sampling (maps to `.random(top:)` on iOS) |
| `tools` | `ToolDefinition[]` | Tools the model can invoke (iOS 26+; Android native version 1 and eligible selected model) |
| `androidModel` | `'default' \| 'previewFast'` | Explicit Android model selection; ignored on iOS |
| `toolTimeout` | `number` | Seconds before an unresolved tool call times out (default 30) |
| `responseFormat` | `"text" \| "json"` | Set to `"json"` for native constrained output on iOS; requires `schema`. Android rejects `"json"`. |
| `schema` | `Schema` | Schema for structured output (used with `responseFormat: "json"`); see [Structured output in the hook](../README.md#structured-output-in-the-hook) |
| `includeSchemaInPrompt` | `boolean` | iOS 26+: include the schema definition in the prompt. Default `true`. Set `false` when you've front-loaded few-shot examples. |

### Returns

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
| `respond` | `(prompt: LLMPrompt) => Promise<string>` | Non-streaming generation. `undefined` when unavailable. |
| `session` | `LLMSession \| null` | The native session object. `null` before creation or when unavailable. Use the hook's generation methods for hook-managed state and tool dispatch. |
| `streamResponse` | `(prompt: LLMPrompt) => Promise<string>` | Streaming generation (updates `streamedText`). Resolves with the final text at stream end, or the partial text if cancelled; rejects on stream failure. `undefined` when model not `available`. |
| `cancelStream` | `() => Promise<void>` | Cancel the active stream; the pending `streamResponse` promise resolves with the partial text. Available whenever a session exists, even if model readiness changes. |
| `reset` | `() => void` | Clear the conversation transcript, keeping instructions/tools/schema/options. Also cancels any in-flight stream. `undefined` only when there is no session. |
| `downloadModel` | `() => Promise<void>` | Trigger model download (Android). `undefined` when unavailable. |

## `generate(prompt, config?)`

One-shot stateless generation — creates a session, responds once, and releases it. Takes the
same generation config as `useLocalLLM`/`createLLMSession`, except tool handlers are not supported. Use it for classification or extraction
calls where conversation history between calls is unwanted. Throws when the module or model
is unavailable (check `ExpoLocalLlmModule.getAvailability()` first if you need to gate).

Use `useLocalLLM()` for automatic tool dispatch. Low-level `createLLMSession()` consumers must subscribe to `toolCall` and resolve or reject each call themselves; passing handlers in its configuration does not install those listeners.

## `generateObject(prompt, config)`

One-shot structured generation with a required `schema`. Returns an object whose type is inferred from the schema, after validating every required field, primitive type, enum, array item, and nested object. Unexpected properties are rejected. Use inline schema literals or `as const satisfies Schema` to preserve enum literal types.

`mode` is `'auto' | 'constrained' | 'validated'`; omitted means `'auto'`. Automatic mode selects native constrained output when available and otherwise uses validated text generation. Explicit `'constrained'` rejects when native constraints are unavailable. Explicit `'validated'` uses the text integration on iOS or Android. A provider failure never falls back to another mode. Tools are rejected before session creation, including runtime JS configurations.

Automatic mode has no cancellation option. To use an `AbortSignal`, choose `mode: 'validated'` explicitly; on iOS this also opts out of native constrained decoding.

Validated mode accepts `repairAttempts?: 0 | 1` (default `1`) and `signal?: AbortSignal`. Other retry counts and validated-only options in automatic or constrained mode reject with `ERR_UNSUPPORTED_REQUEST`. An abort rejects with an `Error` whose `name` is `'AbortError'` (no new native error code); already-aborted calls do no native work. Every owned session is released on completion, failure, or abort, with late native settlements observed and abort listeners removed.

Validated mode snapshots schema fields, enums, task text, options, and image records before awaiting generation. It preserves local URI references without copying files or downloading images. Schema definitions are limited to 16 field levels and 16,384 serialized JavaScript string characters; malformed, cyclic, or unserializable schemas reject with `ERR_SCHEMA_INVALID`. Each request, including instructions and serialized image records, and each returned response is limited to 65,536 JavaScript string characters (UTF-16 code units). Repair context includes the original request, prior output, and validation errors within that same request limit. Oversize input/output/context rejects with `ERR_UNSUPPORTED_REQUEST`, without truncation or repair. These checks do not bound SDK allocation before a response returns; the model's own context and `maxTokens` limits still apply.

`validateStructuredOutput(value, schema)` is also available for checking an already-parsed value against a valid schema. It returns `{ ok: true }` or `{ ok: false, errors }` with field paths.

## `createLLMSession(config?)`

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

## Error codes

Generation errors and `streamError` events carry these codes. Validated-mode cancellation uses `AbortError` without a code. Messages come from the OS and may change; codes do not.

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
| `ERR_RESPONSE_FORMAT_NOT_SUPPORTED` | The requested structured-output mode is not supported by the integration. Android supports explicit validated mode, but rejects native constrained JSON. |
| `ERR_TOOL_NOT_SUPPORTED` | Tool calling is not supported by the integration or selected model. |
| `ERR_IMAGE_INVALID` | Invalid image URI, unreadable image, invalid or duplicate label, too many images for the platform, or image rejected as invalid by ML Kit. |
| `ERR_IMAGE_NOT_SUPPORTED` | Image prompts are not supported by this backend. |
| `ERR_MODEL_DOWNLOAD_FAILED` | Android: downloading Gemini Nano failed. |
| `ERR_SCHEMA_INVALID` | A schema is malformed (`SchemaInvalidError`). |
| `ERR_STRUCTURED_OUTPUT_INVALID` | Generated JSON did not match the schema (`StructuredOutputValidationError`). |
| `ERR_UNAVAILABLE` | The native module is missing from this build. |

## `ModelAvailability`

`'available' | 'notEnabled' | 'notReady' | 'notEligible' | 'downloadRequired' | 'downloading' | 'unknown' | 'moduleUnavailable'`

Android readiness is checked asynchronously and may initially be `unknown`. Prefer `useLocalLLM()` for reactive readiness; low-level consumers should listen for the module's `availabilityChange` event instead of treating the first synchronous status read as final.

## `validateSchema(schema)` and `validateStructuredOutput(value, schema)`

`validateSchema` checks a schema and returns `{ ok: true }` or `{ ok: false, errors }` with field paths (missing `items`, `enum` on the wrong type, unknown `type`). `validateStructuredOutput` checks an already-parsed value against a valid schema the same way.
