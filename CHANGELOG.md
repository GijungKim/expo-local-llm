# Changelog

## 0.1.0

Initial release.

- On-device LLM inference via Apple Foundation Models (iOS 26+) and Gemini Nano (Android)
- `useLocalLLM` hook with availability-gated methods
- Streaming text generation with `onToken` events
- Session management via SharedObject/Class DSL
- `downloadModel()` support for Android devices requiring model download
- Availability checking with `ModelAvailability` union type
