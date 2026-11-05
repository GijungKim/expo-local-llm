import ExpoModulesCore
import Foundation
import ImageIO
import UniformTypeIdentifiers

struct ImageInput: Record {
  @Field(.required) var uri: String = ""
  @Field(.required) var label: String = ""
}

struct PromptRecord: Record {
  @Field(.required) var text: String = ""
  @Field var images: [ImageInput] = []

  static func localPrompt(from prompt: Either<String, PromptRecord>) throws -> LocalPrompt {
    if let text: String = prompt.get() {
      return LocalPrompt(text: text)
    }
    let request = try prompt.as(PromptRecord.self)
    guard request.images.count <= 1 else {
      throw ImageInvalidException(
        "This version accepts one image per request; send additional images in separate requests"
      )
    }
    guard let input = request.images.first else {
      return LocalPrompt(text: request.text)
    }
    return LocalPrompt(
      text: request.text,
      image: try LocalImage(input: input)
    )
  }
}

struct LocalPrompt: Sendable {
  let text: String
  let image: LocalImage?

  init(text: String, image: LocalImage? = nil) {
    self.text = text
    self.image = image
  }
}

struct LocalImage: Sendable {
  let url: URL
  let label: String

  init(input: ImageInput) throws {
    let label = input.label
    guard
      !label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
      label.count <= 128,
      !label.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains)
    else {
      throw ImageInvalidException(
        "Image labels must contain 1–128 characters without control characters"
      )
    }

    url = try Self.validateLocalImageURL(input.uri, label: label)
    self.label = label
  }

  private static func validateLocalImageURL(_ uri: String, label: String) throws -> URL {
    guard
      uri.hasPrefix("file://"),
      uri.unicodeScalars.allSatisfy(\.isASCII),
      !uri.unicodeScalars.contains(where: { scalar in
        CharacterSet.controlCharacters.contains(scalar) || scalar == " "
      }),
      !uri.contains("?"),
      !uri.contains("#"),
      hasValidPercentEncoding(uri),
      let components = URLComponents(string: uri),
      components.scheme == "file",
      components.user == nil,
      components.password == nil,
      components.port == nil,
      components.query == nil,
      components.fragment == nil,
      components.host == nil || components.host == "" || components.host == "localhost",
      let parsedURL = components.url,
      parsedURL.isFileURL
    else {
      throw invalidImageURI(label)
    }

    let path = parsedURL.path
    guard
      path.hasPrefix("/"),
      !path.isEmpty,
      !path.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains)
    else {
      throw invalidImageURI(label)
    }

    let fileURL = URL(fileURLWithPath: path)
    guard
      FileManager.default.isReadableFile(atPath: path),
      let source = CGImageSourceCreateWithURL(
        fileURL as CFURL,
        [kCGImageSourceShouldCache: false] as CFDictionary
      ),
      CGImageSourceGetCount(source) > 0,
      let typeIdentifier = CGImageSourceGetType(source),
      UTType(typeIdentifier as String)?.conforms(to: .image) == true,
      let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
      (properties[kCGImagePropertyPixelWidth] as? NSNumber)?.intValue ?? 0 > 0,
      (properties[kCGImagePropertyPixelHeight] as? NSNumber)?.intValue ?? 0 > 0,
      CGImageSourceCreateThumbnailAtIndex(
        source,
        0,
        [
          kCGImageSourceCreateThumbnailFromImageAlways: true,
          kCGImageSourceCreateThumbnailWithTransform: true,
          kCGImageSourceThumbnailMaxPixelSize: 1,
          kCGImageSourceShouldCacheImmediately: true,
        ] as CFDictionary
      ) != nil
    else {
      throw ImageInvalidException("Image \"\(label)\" is missing, unreadable, or not a supported image file")
    }
    return fileURL
  }

  private static func hasValidPercentEncoding(_ value: String) -> Bool {
    let bytes = Array(value.utf8)
    var index = 0
    while index < bytes.count {
      if bytes[index] == 0x25 {
        guard
          index + 2 < bytes.count,
          isHexDigit(bytes[index + 1]),
          isHexDigit(bytes[index + 2])
        else {
          return false
        }
        index += 3
      } else {
        index += 1
      }
    }
    return true
  }

  private static func isHexDigit(_ byte: UInt8) -> Bool {
    switch byte {
    case 0x30...0x39, 0x41...0x46, 0x61...0x66:
      return true
    default:
      return false
    }
  }

  private static func invalidImageURI(_ label: String) -> ImageInvalidException {
    ImageInvalidException(
      "Image \"\(label)\" must use a percent-encoded local file:// URL without credentials, a port, query, fragment, or control characters"
    )
  }
}

struct SessionConfig: Record {
  @Field var instructions: String?
  @Field var options: GenerationOptions?
  @Field var tools: [ToolConfig]?
  @Field var toolTimeout: Double?
  @Field var responseFormat: String?
  @Field var schema: [String: Any]?
  @Field var includeSchemaInPrompt: Bool?
}

struct GenerationOptions: Record {
  @Field var temperature: Double?
  @Field var maxTokens: Int?
  @Field var topK: Int?
}

struct ToolConfig: Record {
  @Field var name: String = ""
  @Field var description: String = ""
  @Field var parameters: [String: Any] = [:]
}

struct ToolCallEvent: Record {
  @Field var callId: String = ""
  @Field var toolName: String = ""
  @Field var arguments: [String: Any] = [:]
}
