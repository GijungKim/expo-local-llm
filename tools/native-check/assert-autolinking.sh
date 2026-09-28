#!/usr/bin/env bash
set -euo pipefail

readonly platform="${1:-}"
if [[ "$platform" != "android" && "$platform" != "ios" ]]; then
  echo "usage: $0 <android|ios>" >&2
  exit 64
fi

readonly script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly root="$(cd "$script_dir/../.." && pwd)"
readonly resolved_platform="$([[ "$platform" == "ios" ]] && echo apple || echo android)"
readonly resolution_file="$(mktemp "${TMPDIR:-/tmp}/expo-local-llm-autolinking.XXXXXX")"
trap 'rm -f "$resolution_file"' EXIT

(
  cd "$root/example"
  bunx expo-modules-autolinking resolve --platform "$resolved_platform" --json > "$resolution_file"
)

node - "$resolution_file" "$platform" <<'NODE'
const fs = require('node:fs');

const resolution = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const platform = process.argv[3];
const entry = resolution.modules?.find(
  (candidate) => candidate.packageName === 'expo-local-llm'
);

if (!entry) {
  throw new Error('expo-local-llm is absent from Expo autolinking resolution');
}

if (platform === 'ios') {
  const hasPod = entry.pods?.some((pod) => pod.podName === 'ExpoLocalLlm');
  const hasModule = entry.modules?.some(
    (module) => module.class === 'ExpoLocalLlmModule'
  );
  if (!hasPod || !hasModule) {
    throw new Error('ExpoLocalLlm pod or ExpoLocalLlmModule is absent from Apple resolution');
  }
} else {
  const projects = entry.projects ?? [];
  const hasProject = projects.some((project) => project.name === 'expo-local-llm');
  const hasModule = projects.some((project) =>
    project.modules?.some(
      (module) => module.classifier === 'expo.modules.localllm.ExpoLocalLlmModule'
    )
  );
  if (!hasProject || !hasModule) {
    throw new Error('expo-local-llm Gradle project or module class is absent from Android resolution');
  }
}
NODE

if [[ "$platform" == "ios" ]]; then
  readonly pod_lock="$root/example/ios/Podfile.lock"
  readonly provider="$root/example/ios/Pods/Target Support Files/Pods-expolocalllmexample/ExpoModulesProvider.swift"
  readonly pods_project="$root/example/ios/Pods/Pods.xcodeproj/project.pbxproj"

  grep -Fq -- '- ExpoLocalLlm (' "$pod_lock" || {
    echo "ExpoLocalLlm is absent from Podfile.lock" >&2
    exit 1
  }
  grep -Fq 'internal import ExpoLocalLlm' "$provider" || {
    echo "ExpoModulesProvider does not import ExpoLocalLlm" >&2
    exit 1
  }
  grep -Fq 'ExpoLocalLlmModule.self' "$provider" || {
    echo "ExpoModulesProvider does not register ExpoLocalLlmModule" >&2
    exit 1
  }
  grep -Fq 'ExpoLocalLlmModule.swift in Sources' "$pods_project" || {
    echo "The ExpoLocalLlm Swift source is absent from the Pods project" >&2
    exit 1
  }
fi

echo "Verified expo-local-llm autolinking for $platform"
