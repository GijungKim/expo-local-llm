package expo.modules.localllm;

import com.google.mlkit.genai.common.FunctionArgValue;
import com.google.mlkit.genai.common.FunctionCall;
import java.util.HashMap;
import java.util.Map;

/** Java boundary fixture: a platform map may contain null despite Kotlin metadata. */
final class ToolCallFixtures {
  static FunctionCall withNullArgument(FunctionCall source, String key) {
    Map<String, FunctionArgValue> arguments = new HashMap<>(source.getArguments());
    arguments.put(key, null);
    return new FunctionCall(source.getName(), arguments, source.getId());
  }
}
