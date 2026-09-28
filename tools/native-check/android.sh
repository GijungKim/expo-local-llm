#!/usr/bin/env bash
set -euo pipefail

readonly script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly root="$(cd "$script_dir/../.." && pwd)"

"$script_dir/assert-autolinking.sh" android
cd "$root/example/android"

# assembleDebug compiles the app and every autolinked native module, then proves
# the resulting development APK can be packaged. It does not claim runtime or
# on-device model compatibility.
readonly gradle_log="$(mktemp "${TMPDIR:-/tmp}/expo-local-llm-gradle.XXXXXX")"
trap 'rm -f "$gradle_log"' EXIT

./gradlew projects :expo-local-llm:compileDebugKotlin :app:assembleDebug \
  --no-daemon \
  --stacktrace \
  --console=plain \
  -PreactNativeArchitectures=x86_64 | tee "$gradle_log"

grep -Fq "Project ':expo-local-llm'" "$gradle_log" || {
  echo "Gradle did not include the :expo-local-llm project" >&2
  exit 1
}

grep -Eq '^> Task :expo-local-llm:compileDebugKotlin($| )' "$gradle_log" || {
  echo "Gradle did not compile the expo-local-llm Kotlin module" >&2
  exit 1
}

compiled_class=""
for build_dir in "$root/android/build" "$root/example/node_modules/expo-local-llm/android/build"; do
  if [[ -d "$build_dir" ]]; then
    compiled_class="$(find "$build_dir" -type f \
      -path '*/expo/modules/localllm/ExpoLocalLlmModule.class' -print -quit)"
    if [[ -n "$compiled_class" ]]; then
      break
    fi
  fi
done

[[ -n "$compiled_class" ]] || {
    echo "No compiled ExpoLocalLlmModule Kotlin class was produced" >&2
    exit 1
  }
