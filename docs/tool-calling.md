# Tool calling

[Back to the runnable example](../README.md#tool-calling) · [API reference](api.md)

## Model selection

The existing tool API also works on Android builds with native tool calling version 1. Android checks the selected model's status and `FUNCTION_CALLING` feature before sending a tool request. Google's current [function-calling preview](https://developers.google.com/ml-kit/genai/prompt/android/function-calling) requires eligible hardware and an account enrolled in the AICore Developer Preview, with Gemini Nano 4 Fast available. There is no automatic model selection or fallback.

For Android preview access, pass `androidModel: 'previewFast'` to the hook/session and check `await getModelReadiness('previewFast')`. Default selection stays STABLE + FULL; previewFast explicitly selects PREVIEW + FAST. iOS ignores this option. The hook uses the same selection for readiness, downloads, and availability events.

## Arguments and results

`defineTool()` infers the handler's argument types from `parameters`; it returns the tool unchanged. Handlers return strings, so serialize structured results with `JSON.stringify()`. Tools written inline in `tools` still work, with arguments typed as `Record<string, string | number | boolean>`.

On iOS, tool arguments use the same constrained decoding as structured output: the model fills in a schema built from `parameters`, so every declared parameter arrives with its declared type and any `enum` is respected. Validate values whose meaning matters (ranges, formats) as you would any input. If a handler throws or times out, the turn rejects with `ERR_TOOL_FAILED`.

Android validates every declaration and the entire returned batch before the first handler event. Every declared parameter is required; only strings (including string enums), booleans, and numbers are accepted. Missing/extra keys, nulls, nested values, nonfinite numbers, unsafe 64-bit integers, and unknown tool names fail the turn. Android tool and parameter names must match `[A-Za-z_][A-Za-z0-9_]{0,63}`. Application-specific ranges and permissions still belong in your handler.

Non-null SDK call IDs must be unique across the entire generation. A repeated ID rejects the whole batch before any of its handlers execute. Calls without SDK IDs remain supported; the library cannot infer whether two calls with different or missing IDs represent the same intended action.

## Failures and execution limits

Before inference, a selected model that needs downloading or is otherwise unavailable fails with `ERR_MODEL_UNAVAILABLE`. Confirmed absence of function calling on a ready model fails with `ERR_TOOL_NOT_SUPPORTED`. Readiness query failures retain normal SDK error mapping (for example, `ERR_RATE_LIMITED` or `ERR_GENERATION_FAILED`).

Android executes calls sequentially with one outer request ID, at most **8 tool-bearing rounds** and **32 calls** per generation, and **65,536 UTF-8 bytes per result**. The default handler timeout is **30 seconds**, configurable with a finite positive `toolTimeout`. Handler rejection, timeout, invalid model calls, truncated tool turns, or limit violations end the generation with `ERR_TOOL_FAILED`; handlers are never automatically retried. Results remain opaque strings wrapped as `{ result: value }` in native function responses.

## Streaming and cancellation

Streaming tools use ML Kit's callback API and execute only the validated complete terminal batch. Text accumulates across rounds with one outer `streamComplete`. Cancellation returns accumulated text without committing history or emitting completion. Reset, release, and tool registration changes cancel pending work; await the old generation before starting another. `registerTool()` and `unregisterTool()` preserve committed history; changing hook configuration creates a new session. Android retains at most ten whole exchanges, including each exchange's model calls and user results, so trimming cannot orphan tool protocol.
