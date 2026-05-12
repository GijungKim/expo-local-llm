import FoundationModels
import Foundation

enum SchemaBuildError: LocalizedError {
  case unsupportedType(String)
  case malformed(String)

  var errorDescription: String? {
    switch self {
    case .unsupportedType(let type): return "Unsupported schema type: \(type)"
    case .malformed(let message): return "Malformed schema: \(message)"
    }
  }
}

@available(iOS 26, *)
enum GenerationSchemaBuilder {
  static func build(properties: [String: Any], rootName: String = "Response") throws -> GenerationSchema {
    let root = try buildObject(name: rootName, properties: properties)
    return try GenerationSchema(root: root, dependencies: [])
  }

  private static func buildObject(name: String, properties: [String: Any]) throws -> DynamicGenerationSchema {
    let props: [DynamicGenerationSchema.Property] = try properties.map { key, value in
      guard let field = value as? [String: Any] else {
        throw SchemaBuildError.malformed("Field '\(key)' must be an object")
      }
      return try buildProperty(name: key, field: field)
    }
    return DynamicGenerationSchema(name: name, properties: props)
  }

  private static func buildProperty(name: String, field: [String: Any]) throws -> DynamicGenerationSchema.Property {
    let type = field["type"] as? String ?? "string"
    let description = field["description"] as? String
    let schema = try buildSchema(name: name, type: type, field: field)
    return DynamicGenerationSchema.Property(name: name, description: description, schema: schema)
  }

  private static func buildSchema(name: String, type: String, field: [String: Any]) throws -> DynamicGenerationSchema {
    switch type {
    case "string":
      if let enumValues = field["enum"] as? [String] {
        return DynamicGenerationSchema(name: name, anyOf: enumValues)
      }
      return DynamicGenerationSchema(type: String.self)
    case "number":
      return DynamicGenerationSchema(type: Double.self)
    case "integer":
      return DynamicGenerationSchema(type: Int.self)
    case "boolean":
      return DynamicGenerationSchema(type: Bool.self)
    case "array":
      guard let items = field["items"] as? [String: Any] else {
        throw SchemaBuildError.malformed("Array field '\(name)' must declare 'items'")
      }
      let itemType = items["type"] as? String ?? "string"
      let itemSchema = try buildSchema(name: "\(name)Item", type: itemType, field: items)
      return DynamicGenerationSchema(arrayOf: itemSchema)
    case "object":
      let nested = field["properties"] as? [String: Any] ?? [:]
      return try buildObject(name: name, properties: nested)
    default:
      throw SchemaBuildError.unsupportedType(type)
    }
  }
}
