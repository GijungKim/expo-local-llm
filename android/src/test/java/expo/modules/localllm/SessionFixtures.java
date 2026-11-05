package expo.modules.localllm;

import com.google.mlkit.genai.common.FunctionCall;
import com.google.mlkit.genai.prompt.Candidate;
import com.google.mlkit.genai.prompt.GenerateContentResponse;
import java.util.Collections;
import java.util.List;
import java.lang.reflect.Constructor;

/** Reflection accesses the SDK's public synthetic constructors for immutable response fixtures. */
final class SessionFixtures {
  static Candidate candidate(String text, List<FunctionCall> calls, Integer finishReason) {
    try {
      return (Candidate) constructor(Candidate.class, 4)
          .newInstance(text, calls, finishReason, null);
    } catch (ReflectiveOperationException error) {
      throw new AssertionError("Unable to construct SDK candidate fixture", error);
    }
  }

  static GenerateContentResponse response(Candidate candidate) {
    try {
      return (GenerateContentResponse) constructor(GenerateContentResponse.class, 3)
          .newInstance(Collections.singletonList(candidate), Collections.emptyList(), null);
    } catch (ReflectiveOperationException error) {
      throw new AssertionError("Unable to construct SDK response fixture", error);
    }
  }

  private static Constructor<?> constructor(Class<?> type, int parameterCount) {
    for (Constructor<?> constructor : type.getDeclaredConstructors()) {
      if (constructor.getParameterCount() == parameterCount) {
        return constructor;
      }
    }
    throw new AssertionError("SDK fixture constructor changed: " + type.getName());
  }
}
