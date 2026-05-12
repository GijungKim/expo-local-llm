# Changelog

## 0.3.0

- **Constrained decoding for structured output (iOS 26+)** — `responseFormat: "json"` with a `schema`
  now uses Apple's `DynamicGenerationSchema` / `GenerationSchema` instead of instruction-based JSON
  guidance. The model is guaranteed to emit a structurally-valid JSON object that matches the schema.
- **Streaming with structured output** — `streamResponse()` now emits `partial` events when a schema
  is set. The hook exposes `streamedJSON` (current partial as JSON string) and `streamedObject`
  (parsed JS value) parallel to `streamedText`.
- **Richer `Schema` type** — schema fields are now a discriminated union supporting `string`
  (with optional `enum`), `number`, `integer`, `boolean`, `array` (with required `items`), and
  `object` (with `properties`). Replaces the prior `Record<string, any>`.
- **`includeSchemaInPrompt` option** (iOS 26+) — pass `false` to omit the schema definition from the
  prompt when you've front-loaded few-shot examples. Defaults to `true`.

**Breaking (TS only):** the schema type narrowed from `Record<string, any>` to a structural union.
Existing schemas using `{ type: 'string' | 'number' | 'boolean' }` or `{ type: 'array' }` with `items`
keep working; loosely-typed schemas may need updates. No runtime breaking changes.

Validated on iPhone with iOS 26.3 (Apple Intelligence enabled). See `docs/structured-output.png`.

## 0.2.2

- Fix iOS build: `Tool` type from `FoundationModels` was referenced in `LLMSession.swift` which doesn't
  import that framework. Moved to `[DynamicTool]` array (our own type) and let `FoundationModelBridge`
  handle the `[any Tool]` conversion internally.

## 0.2.1

- Fix iOS build error: remove `Events()` from `Class()` block — not supported in ExpoModulesCore
  (SharedObject events are emitted via `session.emit()` and don't need a declaration)

## 0.2.0

- **Tool calling support (iOS 26+)** — register tools with JSON schemas via `useLocalLLM({ tools })`;
  the model invokes them during generation, calls route to JS handlers, results resume the session
- **Structured output** — pass `responseFormat: "json"` with an optional `schema` to get JSON responses
- **`activeToolCalls` state** — hook exposes in-flight tool calls for "using tool..." UI indicators
- **Android tool rejection** — session creation throws immediately if tools are passed on Android,
  surfaced via the hook's `error` state instead of silently falling back to plain generation
- Configurable `toolTimeout` (default 30s) auto-rejects unresponsive JS handlers

**Note:** Tool calling requires iOS 26+ with Apple Intelligence enabled. On-device runtime verification
is recommended before shipping to production. Android tool calling is not yet supported.

## 0.1.3

- Fix streaming text duplication on iOS — `ResponseStream` snapshots are already accumulated, no longer doubled
- Fix `streamComplete` event — sets `streamedText` to final value before clearing `isGenerating`

## 0.1.2

- Fix iOS build — remove `Events()` from `Class()` block (not supported in ExpoModulesCore)
- Fix iOS `SystemLanguageModel.Availability` enum — `.notAvailable` → `.unavailable` to match actual iOS 26 SDK

## 0.1.1

- Fix iOS podspec minimum deployment target (16.0) to allow installation in projects targeting 16.0+

## 0.1.0

Initial release.

- On-device LLM inference via Apple Foundation Models (iOS 26+) and Gemini Nano (Android)
- `useLocalLLM` hook with availability-gated methods
- Streaming text generation with `onToken` events
- Session management via SharedObject/Class DSL
- `downloadModel()` support for Android devices requiring model download
- Availability checking with `ModelAvailability` union type
