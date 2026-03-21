import ExpoModulesCore

struct SessionConfig: Record {
  @Field var instructions: String?
  @Field var options: GenerationOptions?
  @Field var tools: [ToolConfig]?
  @Field var toolTimeout: Double?
  @Field var responseFormat: String?
  @Field var schema: [String: Any]?
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
