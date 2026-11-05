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

- Requirements: Node 24, Bun 1.4.4 (matching CI). The SDK 58 example requires Xcode 26.4+ on iOS; Android requires SDK 37, NDK 27.1.12297006, and JDK 17. See [native compile checks](tools/native-check/README.md).
- Install dependencies and validate:

  ```bash
  bun install --frozen-lockfile
  bun run lint
  bun run test:anti-slop
  bun run lint:typed
  bun run test:typed-lint
  bun run test:build-script
  bun run knip
  bun run test -- --runInBand
  bun run typecheck
  bun run test:types
  bun run build
  bun run check:size
  ```

- `check:size` uses Bun 1.4.4, matching CI, to measure all exports from the built package entry point with external packages excluded. Keep the README's measurement and footnote current when changing the JS size budgets or measurement tooling. This measures standalone JavaScript, not native app overhead.

- Type checks and the default build use the experimental `tsrs` compiler pinned at `0.21.0-ts7.1.0-beta`. On macOS arm64 and Linux x64/arm64, builds emit JavaScript, declarations, and source maps with `tsrs`; `prepublishOnly` runs Expo's clean command and then the same build noninteractively.
- Intel Mac, Windows, and other unsupported hosts select Expo's existing TypeScript 6.0.3 build before compilation and print a fallback diagnostic. Named `plugin`, `cli`, `utils`, and `scripts` build targets also remain delegated to Expo. A `tsrs` compilation failure never retries with TypeScript, so compiler errors cannot silently publish different output.
- `bun run expo-module build` remains available to invoke the legacy emitter explicitly for comparison or troubleshooting.
- Updating the `tsrs` pin requires review and an output comparison against TypeScript 6.0.3 covering every emitted JavaScript file, declaration, and source map. Source-map review must check usable navigation as well as valid coordinates and source content.
- `tsconfig.typecheck.json` checks non-emitting inference fixtures without declaration generation. The main build still generates and checks the package's public declarations; test helper return types are not package exports.
- The pinned `tsrs` package also provides Intel Mac and Windows x64 binaries. The build wrapper retains its validated macOS arm64/Linux emission scope; use `bunx tsc --project tsconfig.json --noEmit` and `bunx tsc --project tsconfig.typecheck.json --noEmit` as manual type-check fallbacks on other hosts. CI remains authoritative.

- `lint:typed` runs the compiler package's `tsrs-lint` launcher as Oxlint's type-aware backend for runtime source. It adds `no-floating-promises` and `no-misused-promises` while inheriting the anti-slop rules; test source stays in the existing lint/type-test gates. `test:typed-lint` invokes that same command against temporary valid and invalid source files and removes them afterward. Run source scans after this test finishes, so they cannot pick up its temporary fixture. The compiler, Oxlint, and plugin utilities move as one reviewed Renovate group.

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
