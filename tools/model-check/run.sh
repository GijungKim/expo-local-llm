#!/usr/bin/env bash
set -euo pipefail

# Compiles the library's Foundation Models sources with a small harness and
# runs them against the real system model. Requires macOS 26+ on Apple
# silicon with Apple Intelligence enabled and its model downloaded.

readonly script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly root="$(cd "$script_dir/../.." && pwd)"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "The model check runs on macOS only." >&2
  exit 2
fi

build_dir="$(mktemp -d "${TMPDIR:-/tmp}/expo-local-llm-model-check.XXXXXX")"
trap 'rm -rf "$build_dir"' EXIT

# Target the 26 OSes the library supports rather than the host's newer SDK
# defaults, so the iOS 26 code paths compile exactly as they ship.
xcrun swiftc -parse-as-library -O \
  -target "$(uname -m)-apple-macos26.0" \
  "$root/ios/DynamicTool.swift" \
  "$root/ios/GenerationSchemaBuilder.swift" \
  "$root/ios/GenerationErrorCodes.swift" \
  "$script_dir/ModelCheck.swift" \
  -o "$build_dir/model-check"

"$build_dir/model-check"
