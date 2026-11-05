import type { InferSchema, Schema, SchemaField } from "./ExpoLocalLlm.types";

export type SchemaValidationError = {
  path: string;
  message: string;
};

export type SchemaValidationResult =
  | { ok: true }
  | { ok: false; errors: SchemaValidationError[] };

export class SchemaInvalidError extends Error {
  readonly code = "ERR_SCHEMA_INVALID";
  readonly errors: SchemaValidationError[];
  constructor(errors: SchemaValidationError[]) {
    const summary = errors.map((e) => `  - ${e.path}: ${e.message}`).join("\n");
    super(`Invalid schema:\n${summary}`);
    this.name = "SchemaInvalidError";
    this.errors = errors;
  }
}

export class StructuredOutputValidationError extends Error {
  readonly code = "ERR_STRUCTURED_OUTPUT_INVALID";
  readonly errors: SchemaValidationError[];
  constructor(errors: SchemaValidationError[]) {
    const summary = errors.map((e) => `  - ${e.path}: ${e.message}`).join("\n");
    super(`Generated object does not match schema:\n${summary}`);
    this.name = "StructuredOutputValidationError";
    this.errors = errors;
  }
}

const ALLOWED_TYPES = new Set([
  "string",
  "number",
  "integer",
  "boolean",
  "array",
  "object",
]);

function isPlainObject<Value>(v: Value): v is Value & Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function copyField(field: SchemaField, depth: number): SchemaField {
  if (depth > 16) throw new Error("Schema exceeds 16 levels.");
  if (!isPlainObject(field)) throw new Error("Schema fields must be objects.");
  if ("toJSON" in field)
    throw new Error("Schema serialization hooks are unsupported.");
  switch (field.type) {
    case "object":
      return { ...field, properties: copySchema(field.properties, depth + 1) };
    case "array":
      return { ...field, items: copyField(field.items, depth + 1) };
    case "string": {
      if (!("enum" in field)) return { ...field };
      const values = field.enum;
      if (!Array.isArray(values)) throw new Error("Enum must be an array.");
      const copied: string[] = [];
      for (let index = 0; index < values.length; index++) {
        const value = values[index];
        copied.push(value);
      }
      return { ...field, enum: copied };
    }
    default:
      return { ...field };
  }
}

function copySchema(schema: Schema, depth: number): Schema {
  if (!isPlainObject(schema))
    throw new Error("Schema containers must be objects.");
  return Object.fromEntries(
    Object.entries(schema).map(([key, field]) => [key, copyField(field, depth)])
  );
}

export function snapshotSchema<const Definition extends Schema>(
  schema: Definition
): Definition {
  try {
    // Bounded recursion rejects cycles too; serialize the independent copy.
    const snapshot = copySchema(schema, 1);
    const validation = validateSchema(snapshot);
    if (!validation.ok) throw new SchemaInvalidError(validation.errors);
    if (JSON.stringify(snapshot).length > 16_384) {
      throw new Error("Schema exceeds 16384 characters.");
    }
    // SAFETY: copySchema preserves each field, enum and container in Definition;
    // validateSchema checked the independent copy before it is used or returned.
    return snapshot as Definition;
  } catch (error) {
    if (error instanceof SchemaInvalidError) throw error;
    throw new SchemaInvalidError([
      {
        path: "$",
        message:
          error instanceof Error ? error.message : "Cannot snapshot schema.",
      },
    ]);
  }
}

function validateField(
  field: unknown,
  path: string,
  errors: SchemaValidationError[]
): void {
  if (!isPlainObject(field)) {
    errors.push({ path, message: "field must be an object" });
    return;
  }

  const type = field.type;
  if (typeof type !== "string" || !ALLOWED_TYPES.has(type)) {
    errors.push({
      path,
      message: `type must be one of: string, number, integer, boolean, array, object (got: ${JSON.stringify(
        type
      )})`,
    });
    return;
  }

  if ("enum" in field) {
    if (type !== "string") {
      errors.push({
        path,
        message: `enum is only valid on type 'string' (got type: '${type}')`,
      });
    } else if (!Array.isArray(field.enum) || field.enum.length === 0) {
      errors.push({
        path,
        message: "enum must be a non-empty array of strings",
      });
    } else if (!field.enum.every((v) => typeof v === "string")) {
      errors.push({
        path,
        message: "enum values must all be strings",
      });
    }
  }

  if (type === "array") {
    if (!("items" in field)) {
      errors.push({ path, message: "type 'array' requires 'items'" });
    } else {
      validateField(field.items, `${path}.items`, errors);
    }
  }

  if (type === "object") {
    if (!("properties" in field)) {
      errors.push({ path, message: "type 'object' requires 'properties'" });
    } else if (!isPlainObject(field.properties)) {
      errors.push({
        path: `${path}.properties`,
        message: "properties must be an object",
      });
    } else {
      const entries = Object.entries(field.properties);
      if (entries.length === 0) {
        errors.push({
          path: `${path}.properties`,
          message: "properties must be non-empty",
        });
      } else {
        for (const [key, subField] of entries) {
          validateField(subField, `${path}.${key}`, errors);
        }
      }
    }
  }
}

export function validateSchema(schema: unknown): SchemaValidationResult {
  const errors: SchemaValidationError[] = [];

  if (!isPlainObject(schema)) {
    errors.push({ path: "$", message: "schema must be an object" });
    return { ok: false, errors };
  }

  const entries = Object.entries(schema);
  if (entries.length === 0) {
    errors.push({ path: "$", message: "schema must be a non-empty object" });
    return { ok: false, errors };
  }

  for (const [key, field] of entries) {
    validateField(field, key, errors);
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

function validateValueField(
  value: unknown,
  field: SchemaField,
  path: string,
  errors: SchemaValidationError[]
): void {
  switch (field.type) {
    case "string":
      if (typeof value !== "string") {
        errors.push({ path, message: "expected string" });
      } else if (field.enum && !field.enum.includes(value)) {
        errors.push({
          path,
          message: `expected one of: ${field.enum.join(", ")}`,
        });
      }
      break;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        errors.push({ path, message: "expected finite number" });
      }
      break;
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value)) {
        errors.push({ path, message: "expected integer" });
      }
      break;
    case "boolean":
      if (typeof value !== "boolean") {
        errors.push({ path, message: "expected boolean" });
      }
      break;
    case "array":
      if (!Array.isArray(value)) {
        errors.push({ path, message: "expected array" });
      } else {
        for (const [index, item] of value.entries()) {
          validateValueField(item, field.items, `${path}[${index}]`, errors);
        }
      }
      break;
    case "object":
      if (!isPlainObject(value)) {
        errors.push({ path, message: "expected object" });
      } else {
        for (const [key, property] of Object.entries(field.properties)) {
          if (!Object.prototype.hasOwnProperty.call(value, key)) {
            errors.push({
              path: `${path}.${key}`,
              message: "required property is missing",
            });
          } else {
            validateValueField(value[key], property, `${path}.${key}`, errors);
          }
        }
        for (const key of Object.keys(value)) {
          if (!Object.prototype.hasOwnProperty.call(field.properties, key)) {
            errors.push({
              path: `${path}.${key}`,
              message: "unexpected property",
            });
          }
        }
      }
      break;
  }
}

export function validateStructuredOutput(
  value: unknown,
  schema: Schema
): SchemaValidationResult {
  const errors: SchemaValidationError[] = [];
  if (!isPlainObject(value)) {
    return { ok: false, errors: [{ path: "$", message: "expected object" }] };
  }

  for (const [key, field] of Object.entries(schema)) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      errors.push({
        path: `$.${key}`,
        message: "required property is missing",
      });
    } else {
      validateValueField(value[key], field, `$.${key}`, errors);
    }
  }
  for (const key of Object.keys(value)) {
    if (!Object.prototype.hasOwnProperty.call(schema, key)) {
      errors.push({ path: `$.${key}`, message: "unexpected property" });
    }
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/**
 * Parse a structured-output response and check it against the schema. Native
 * decoding is constrained, but the result is still verified before it is
 * typed as the schema's shape.
 */
export function parseStructuredOutput<const Definition extends Schema>(
  text: string,
  schema: Definition
): InferSchema<Definition> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new StructuredOutputValidationError([
      {
        path: "$",
        message: `expected valid JSON (${
          error instanceof Error ? error.message : "parse failed"
        })`,
      },
    ]);
  }
  const validation = validateStructuredOutput(value, schema);
  if (!validation.ok) {
    throw new StructuredOutputValidationError(validation.errors);
  }
  // SAFETY: validateStructuredOutput recursively checked every field against
  // Definition immediately above, including nested containers and enums.
  return value as InferSchema<Definition>;
}

// Re-export Schema so callers building schemas at runtime have one import surface.
export type { Schema };
