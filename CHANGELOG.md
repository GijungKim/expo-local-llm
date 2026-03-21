# Changelog

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
