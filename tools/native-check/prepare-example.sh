#!/usr/bin/env bash
set -euo pipefail

readonly platform="${1:-}"
if [[ "$platform" != "android" && "$platform" != "ios" ]]; then
  echo "usage: $0 <android|ios>" >&2
  exit 64
fi

readonly script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly root="$(cd "$script_dir/../.." && pwd)"

cd "$root"

# The package must be built before the example resolves its file:.. dependency.
bun install --frozen-lockfile
bun run build

# Always compile a freshly generated SDK 57 project rather than accepting stale
# checked-in native output. --no-install keeps dependency installation explicit.
rm -rf "example/node_modules" "example/$platform"
(
  cd example
  bun install --frozen-lockfile
  CI=1 bunx expo prebuild --clean --no-install --platform "$platform"
)

if [[ "$platform" == "ios" ]]; then
  (
    cd example/ios
    pod install
  )
fi

"$script_dir/assert-autolinking.sh" "$platform"
