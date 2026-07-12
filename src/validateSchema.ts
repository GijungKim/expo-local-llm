import type { Schema } from "./ExpoLocalLlm.types";

export type SchemaValidationError = {
  path: string;
  message: string;
};

export type SchemaValidationResult =
  | { ok: true }
  | { ok: false; errors: SchemaValidationError[] };

export class SchemaInvalidError extends Error {
  readonly errors: SchemaValidationError[];
  constructor(errors: SchemaValidationError[]) {
    const summary = errors.map((e) => `  - ${e.path}: ${e.message}`).join("\n");
    super(`Invalid schema:\n${summary}`);
    this.name = "SchemaInvalidError";
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

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
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

// Re-export Schema so callers building schemas at runtime have one import surface.
export type { Schema };
