import { generateObject } from "../index";

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

export { verifyGenerateObjectInference };
