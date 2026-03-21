package expo.modules.localllm

import expo.modules.kotlin.types.Enumerable

enum class ModelAvailability(val value: String) : Enumerable {
  available("available"),
  notEnabled("notEnabled"),
  notReady("notReady"),
  notEligible("notEligible"),
  downloadRequired("downloadRequired"),
  downloading("downloading"),
  unknown("unknown")
}
