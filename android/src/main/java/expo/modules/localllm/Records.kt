package expo.modules.localllm

import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import expo.modules.kotlin.records.Required

class SessionConfig : Record {
  @Field
  var androidModel: String? = null

  @Field
  var instructions: String? = null

  @Field
  var options: GenerationOptionsRecord? = null

  @Field
  var tools: List<ToolConfig>? = null

  @Field
  var toolTimeout: Double? = null

  @Field
  var responseFormat: String? = null

  @Field
  var schema: Map<String, Any>? = null
}

class GenerationOptionsRecord : Record {
  @Field
  var temperature: Float? = null

  @Field
  var maxTokens: Int? = null

  @Field
  var topK: Int? = null
}

class PromptRecord : Record {
  @Required
  @Field
  var text: String = ""

  @Field
  var images: List<ImageInputRecord>? = null
}

class ImageInputRecord : Record {
  @Field
  var uri: String = ""

  @Field
  var label: String = ""
}

class ToolConfig : Record {
  @Field
  var name: String = ""

  @Field
  var description: String = ""

  @Field
  var parameters: Map<String, Any> = emptyMap()
}
