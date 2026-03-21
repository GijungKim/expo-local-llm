package expo.modules.localllm

import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

class SessionConfig : Record {
  @Field
  var instructions: String? = null

  @Field
  var options: GenerationOptionsRecord? = null
}

class GenerationOptionsRecord : Record {
  @Field
  var temperature: Float? = null

  @Field
  var maxTokens: Int? = null

  @Field
  var topK: Int? = null
}
