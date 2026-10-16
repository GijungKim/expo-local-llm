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
# Created before Gradle runs, so stale test results from an earlier local build
# cannot satisfy the check below.
readonly build_started="$(mktemp "${TMPDIR:-/tmp}/expo-local-llm-started.XXXXXX")"
trap 'rm -f "$gradle_log" "$build_started"' EXIT

# JDK 24+ restricts native access (JEP 472). Gradle's CMake configure step calls
# a restricted method, and the resulting JVM warning fails the build unless
# native access is explicitly enabled. Scoped to the Gradle invocation so the
# opt-in does not leak into unrelated JVMs.
JAVA_TOOL_OPTIONS="${JAVA_TOOL_OPTIONS:+$JAVA_TOOL_OPTIONS }--enable-native-access=ALL-UNNAMED" \
  ./gradlew projects :expo-local-llm:compileDebugKotlin :expo-local-llm:testDebugUnitTest :app:assembleDebug \
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

# Gradle passes a task with no matching sources as NO-SOURCE, so assert that
# unit test results were actually produced rather than trusting the task. The
# example autolinks the package from the repository root, so its Gradle output
# lands in the repository's android/build.
readonly module_build="$root/android/build"

test_results="$(find "$module_build/test-results/testDebugUnitTest" \
  -name 'TEST-*.xml' -newer "$build_started" -print -quit 2>/dev/null || true)"
[[ -n "$test_results" ]] || {
  echo "No JVM unit test results were produced for expo-local-llm" >&2
  exit 1
}

compiled_class="$(find "$module_build" -type f \
  -path '*/expo/modules/localllm/ExpoLocalLlmModule.class' -print -quit 2>/dev/null || true)"
[[ -n "$compiled_class" ]] || {
  echo "No compiled ExpoLocalLlmModule Kotlin class was produced" >&2
  exit 1
}
