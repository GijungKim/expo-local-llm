#!/usr/bin/env bash
set -euo pipefail

readonly script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly root="$(cd "$script_dir/../.." && pwd)"
readonly required_xcode="26.4"

actual_xcode="$(xcodebuild -version | awk '/^Xcode / { print $2 }')"
IFS=. read -r actual_major actual_minor _ <<< "$actual_xcode"
if (( actual_major < 26 || (actual_major == 26 && actual_minor < 4) )); then
  echo "Xcode $required_xcode or newer is required; found $actual_xcode" >&2
  exit 1
fi

cd "$root"
readonly workspace="example/ios/expolocalllmexample.xcworkspace"
readonly scheme="expolocalllmexample"
readonly derived_data="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/expo-local-llm-derived-data"
readonly build_log="$derived_data/xcodebuild.log"

"$script_dir/assert-autolinking.sh" ios
rm -rf "$derived_data"
mkdir -p "$derived_data"

# A generic Simulator destination compiles and links Swift (including the weak
# FoundationModels import) without requiring signing or booting a simulator.
# This is a compile gate only; Foundation Models availability requires a
# supported physical device and is not inferred from this build.
xcodebuild \
  -workspace "$workspace" \
  -scheme "$scheme" \
  -configuration Debug \
  -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath "$derived_data" \
  CODE_SIGNING_ALLOWED=NO \
  COMPILER_INDEX_STORE_ENABLE=NO \
  build | tee "$build_log"

grep -Fq "target 'ExpoLocalLlm'" "$build_log" || {
  echo "xcodebuild did not build the ExpoLocalLlm pod target" >&2
  exit 1
}

find "$derived_data/Build/Intermediates.noindex/Pods.build" \
  -path '*ExpoLocalLlm.build*' \
  -type f \
  \( -name '*.o' -o -name '*.swiftmodule' \) \
  -print -quit | grep -q . || {
    echo "No compiled ExpoLocalLlm object or Swift module was produced" >&2
    exit 1
  }
