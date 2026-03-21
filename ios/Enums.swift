import ExpoModulesCore

enum ModelAvailability: String, Enumerable {
  case available
  case notEnabled
  case notReady
  case notEligible
  case downloadRequired
  case downloading
  case unknown
}
