import ExpoModulesCore

struct SessionConfig: Record {
  @Field var instructions: String?
  @Field var options: GenerationOptions?
}

struct GenerationOptions: Record {
  @Field var temperature: Double?
  @Field var maxTokens: Int?
  @Field var topK: Int?
}
