# Model check

CI compiles the native code but never runs a model. This check runs the library's Foundation Models code, `DynamicTool`, `GenerationSchemaBuilder` and `GenerationErrorClassifier`, against the real system model on a Mac. You don't need an iPhone.

```sh
tools/model-check/run.sh
```

Requirements: macOS 26 or later on Apple silicon, Apple Intelligence enabled, and its model downloaded. The script exits `0` when every check passes, `1` when any fails, and `2` when the model is unavailable. A skipped run is not a pass.

## What it checks

| Check | Proves |
| --- | --- |
| Tool arguments are decoded against parameters | A tool call delivers exactly the declared keys, with a string, an enum value, and an integer |
| A failing tool handler maps to `ERR_TOOL_FAILED` | A rejected handler surfaces as `ToolCallError` and is classified |
| Context overflow maps to `ERR_CONTEXT_WINDOW_EXCEEDED` | An oversized prompt is classified, whichever error type the OS throws |
| Structured output matches the schema | `GenerationSchemaBuilder` schemas constrain strings, enums and arrays |

The model is not deterministic. The tool check allows three attempts for the model to call the tool, and every check asserts structure, never wording.

## What it does not check

It runs on macOS, so it says nothing about iOS latency, memory or thermals, and nothing about the Expo bridge, events or JavaScript. Those still belong to the [release verification](../../docs/release-verification.md) device record. The Expo-dependent mapper (`GenerationErrorMapper.swift`) is a thin wrapper around the classifier exercised here.

Run it whenever you change Swift that touches tools, schemas or error handling, and before each release.
