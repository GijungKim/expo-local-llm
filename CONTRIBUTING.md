# Contributing to expo-local-llm

We want to make it easy for you to contribute. Here are the most common types of changes that get merged:

- Bug fixes
- Improvements to LLM session handling or streaming
- Platform-specific fixes (iOS/Android quirks)
- Documentation improvements
- Test coverage

However, any core API changes or new platform backends must go through a design review before implementation.

If you are unsure if a PR would be accepted, open an issue first or look for issues labeled:

- [`help wanted`](https://github.com/GijungKim/expo-local-llm/issues?q=is%3Aissue+state%3Aopen+label%3A%22help+wanted%22)
- [`good first issue`](https://github.com/GijungKim/expo-local-llm/issues?q=is%3Aissue+state%3Aopen+label%3A%22good+first+issue%22)
- [`bug`](https://github.com/GijungKim/expo-local-llm/issues?q=is%3Aissue+state%3Aopen+label%3Abug)

> [!NOTE]
> PRs that ignore these guardrails will likely be closed.

## Developing

- Requirements: Node 24, Bun 1.4.2 (matching CI). The SDK 57 example requires Xcode 26.4+ on iOS; Android requires SDK 36, NDK 27.1.12297006, and JDK 17. See [native compile checks](tools/native-check/README.md).
- Install dependencies and validate:

  ```bash
  bun install --frozen-lockfile
  bun run lint
  bun run test:anti-slop
  bun run knip
  bun run test -- --runInBand
  bun run test:types
  bun run build
  ```

- Core pieces:
  - `src/` — TypeScript module (types, hook, SharedObject bridge)
  - `ios/` — Swift implementation (Foundation Models, iOS 26+)
  - `android/` — Kotlin implementation (Gemini Nano via ML Kit)
  - `example/` — Minimal test app

### Testing on device

```bash
# iOS (requires iOS 26+ device with Apple Intelligence)
cd example && npx expo run:ios --device

# Android (requires a device supported by the configured Gemini Nano SDK)
cd example && npx expo run:android --device
```

Install the example's dependencies after building the root package. Use a native development build, not stock Expo Go. Follow the [release verification checklist](docs/release-verification.md) for native changes; unit tests and simulator compilation do not verify physical-device inference.

## Pull Request Expectations

### Issue First Policy

**All PRs must reference an existing issue.** Before opening a PR, open an issue describing the bug or feature. PRs without a linked issue may be closed without review.

- Use `Fixes #123` or `Closes #123` in your PR description

### General Requirements

- Keep pull requests small and focused
- Explain the issue and why your change fixes it
- Before adding new functionality, ensure it doesn't already exist elsewhere in the codebase

### No AI-Generated Walls of Text

Long, AI-generated PR descriptions and issues are not acceptable and may be ignored. Respect the maintainers' time:

- Write short, focused descriptions
- Explain what changed and why in your own words
- If you can't explain it briefly, your PR might be too large

### PR Titles

PR titles should follow conventional commit standards:

- `feat:` new feature or functionality
- `fix:` bug fix
- `docs:` documentation changes
- `chore:` maintenance tasks, dependency updates
- `refactor:` code refactoring without changing behavior
- `test:` adding or updating tests

You can optionally include a scope:

- `fix(ios):` iOS-specific bug fix
- `feat(android):` Android-specific feature
- `chore(ts):` TypeScript maintenance

### Style Preferences

- Follow existing Expo module patterns (Class/SharedObject DSL, Record/@Field, Enumerable)
- Use string union types for options, not booleans or enums (on the TypeScript side)
- Prefer optionality for availability checks over `isAvailable` functions
- Keep native code gated behind `#available` / `@available` (iOS) or try/catch (Android)
- Run `bun run lint` before submitting — CI will reject lint failures

## Feature Requests

For new functionality, start with a design conversation. Open an issue describing the problem and your proposed approach. Wait for maintainer approval before opening a feature PR.
