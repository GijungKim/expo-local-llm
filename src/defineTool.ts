import type { ToolDefinition, ToolParameters } from "./ExpoLocalLlm.types";

/**
 * Declare a tool with its handler's arguments inferred from `parameters`.
 *
 * ```ts
 * const getWeather = defineTool({
 *   name: "getWeather",
 *   description: "Get the current weather for a city",
 *   parameters: {
 *     city: { type: "string", description: "The city name" },
 *     unit: { type: "string", description: "Unit", enum: ["c", "f"] },
 *   },
 *   handler: async ({ city, unit }) => `${city}: 21°${unit}`,
 *   // city: string, unit: "c" | "f"
 * });
 * ```
 */
export function defineTool<const Parameters extends ToolParameters>(
  tool: ToolDefinition<Parameters>
): ToolDefinition<Parameters> {
  return tool;
}
