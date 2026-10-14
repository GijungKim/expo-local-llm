import { defineTool, generateObject, useLocalLLM } from "../index";

type Equal<Left, Right> = (<Value>() => Value extends Left ? 1 : 2) extends <
  Value
>() => Value extends Right ? 1 : 2
  ? true
  : false;
type Expect<Value extends true> = Value;

async function verifyGenerateObjectInference() {
  const result = await generateObject("extract", {
    schema: {
      mood: { type: "string", enum: ["happy", "sad"] },
      nested: {
        type: "object",
        properties: {
          rows: {
            type: "array",
            items: {
              type: "object",
              properties: {
                count: { type: "integer" },
                enabled: { type: "boolean" },
              },
            },
          },
        },
      },
    },
  });

  type MoodIsExact = Expect<Equal<typeof result.mood, "happy" | "sad">>;
  type RowsAreExact = Expect<
    Equal<typeof result.nested.rows, { count: number; enabled: boolean }[]>
  >;
  const moodIsExact: MoodIsExact = true;
  const rowsAreExact: RowsAreExact = true;

  // @ts-expect-error Inline enums must not widen to arbitrary strings.
  const invalidMood: "other" = result.mood;
  // @ts-expect-error Nested integer output is a number, not a string.
  const invalidCount: string = result.nested.rows[0].count;
  // @ts-expect-error The schema does not infer undeclared nested fields.
  const invalidRow: { count: number; missing: string } = result.nested.rows[0];

  return { moodIsExact, rowsAreExact, invalidMood, invalidCount, invalidRow };
}

function useHookInference() {
  const { streamedObject, completedObject, errorCode } = useLocalLLM({
    responseFormat: "json",
    schema: {
      mood: { type: "string", enum: ["happy", "sad"] },
      tags: { type: "array", items: { type: "string" } },
    },
  });

  type CompletedIsExact = Expect<
    Equal<
      typeof completedObject,
      { mood: "happy" | "sad"; tags: string[] } | null
    >
  >;
  type StreamedIsPartial = Expect<
    Equal<
      typeof streamedObject,
      { mood?: "happy" | "sad"; tags?: string[] } | null
    >
  >;
  const completedIsExact: CompletedIsExact = true;
  const streamedIsPartial: StreamedIsPartial = true;

  // @ts-expect-error A streamed field may not have been generated yet.
  const streamedMood: "happy" | "sad" = streamedObject!.mood;
  // @ts-expect-error Error codes are a closed union, not arbitrary strings.
  const unknownCode: typeof errorCode = "ERR_SOMETHING_ELSE";

  return { completedIsExact, streamedIsPartial, streamedMood, unknownCode };
}

function useToolInference() {
  const getWeather = defineTool({
    name: "getWeather",
    description: "Get the current weather",
    parameters: {
      city: { type: "string", description: "City" },
      unit: { type: "string", description: "Unit", enum: ["c", "f"] },
      days: { type: "number", description: "Forecast days" },
      detailed: { type: "boolean", description: "Include hourly data" },
    },
    handler: async (args) => {
      type ArgsAreExact = Expect<
        Equal<
          typeof args,
          { city: string; unit: "c" | "f"; days: number; detailed: boolean }
        >
      >;
      const argsAreExact: ArgsAreExact = true;
      // @ts-expect-error Enum parameters must not widen to arbitrary strings.
      const invalidUnit: "k" = args.unit;
      return `${args.city} ${argsAreExact} ${invalidUnit}`;
    },
  });

  // A typed tool still fits the general tools array.
  const config = useLocalLLM({ tools: [getWeather] });

  defineTool({
    name: "broken",
    description: "Mismatched handler",
    parameters: { count: { type: "number", description: "Count" } },
    // @ts-expect-error A number parameter is not a string.
    handler: async (args: { count: string }) => args.count,
  });

  return config;
}

export { verifyGenerateObjectInference, useHookInference, useToolInference };
