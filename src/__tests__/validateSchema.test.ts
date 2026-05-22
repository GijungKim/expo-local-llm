import { validateSchema, SchemaInvalidError } from "../validateSchema";

describe("validateSchema", () => {
  describe("root", () => {
    it("ok with a non-empty schema", () => {
      expect(validateSchema({ name: { type: "string" } })).toEqual({
        ok: true,
      });
    });

    it("rejects empty schema", () => {
      const r = validateSchema({});
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.errors[0].path).toBe("$");
        expect(r.errors[0].message).toMatch(/non-empty/);
      }
    });

    it("rejects non-object schema", () => {
      expect(validateSchema("foo").ok).toBe(false);
      expect(validateSchema(42).ok).toBe(false);
      expect(validateSchema(null).ok).toBe(false);
      expect(validateSchema(undefined).ok).toBe(false);
      expect(validateSchema([]).ok).toBe(false);
    });
  });

  describe("type field", () => {
    it("accepts all valid types", () => {
      const r = validateSchema({
        a: { type: "string" },
        b: { type: "number" },
        c: { type: "integer" },
        d: { type: "boolean" },
        e: { type: "array", items: { type: "string" } },
        f: { type: "object", properties: { x: { type: "string" } } },
      });
      expect(r).toEqual({ ok: true });
    });

    it("rejects unknown type", () => {
      const r = validateSchema({ x: { type: "blob" } });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.errors[0].path).toBe("x");
        expect(r.errors[0].message).toMatch(/type must be one of/);
      }
    });

    it("rejects missing type", () => {
      expect(validateSchema({ x: {} }).ok).toBe(false);
    });

    it("rejects non-object field", () => {
      const r = validateSchema({ x: "string" });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.errors[0].path).toBe("x");
        expect(r.errors[0].message).toMatch(/field must be an object/);
      }
    });
  });

  describe("enum", () => {
    it("ok on type: 'string'", () => {
      expect(
        validateSchema({
          difficulty: { type: "string", enum: ["easy", "medium", "hard"] },
        }),
      ).toEqual({ ok: true });
    });

    it("rejects enum on non-string type", () => {
      const r = validateSchema({
        n: { type: "number", enum: ["1", "2"] },
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.errors[0].message).toMatch(/only valid on type 'string'/);
      }
    });

    it("rejects empty enum array", () => {
      const r = validateSchema({ x: { type: "string", enum: [] } });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.errors[0].message).toMatch(/non-empty/);
      }
    });

    it("rejects non-string enum values", () => {
      const r = validateSchema({
        x: { type: "string", enum: ["a", 1] },
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.errors[0].message).toMatch(/values must all be strings/);
      }
    });
  });

  describe("array", () => {
    it("requires items", () => {
      const r = validateSchema({ list: { type: "array" } });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.errors[0].path).toBe("list");
        expect(r.errors[0].message).toMatch(/'array' requires 'items'/);
      }
    });

    it("validates items recursively", () => {
      const r = validateSchema({
        list: { type: "array", items: { type: "blob" } },
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.errors[0].path).toBe("list.items");
      }
    });

    it("accepts array of objects", () => {
      expect(
        validateSchema({
          items: {
            type: "array",
            items: {
              type: "object",
              properties: { name: { type: "string" } },
            },
          },
        }),
      ).toEqual({ ok: true });
    });
  });

  describe("object", () => {
    it("requires properties", () => {
      const r = validateSchema({ x: { type: "object" } });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.errors[0].message).toMatch(/requires 'properties'/);
      }
    });

    it("rejects empty properties", () => {
      const r = validateSchema({
        x: { type: "object", properties: {} },
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.errors[0].path).toBe("x.properties");
      }
    });

    it("reports nested errors with full path", () => {
      const r = validateSchema({
        outer: {
          type: "object",
          properties: {
            inner: {
              type: "object",
              properties: { broken: { type: "blob" } },
            },
          },
        },
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.errors[0].path).toBe("outer.inner.broken");
      }
    });
  });

  describe("error collection", () => {
    it("collects multiple errors instead of stopping at first", () => {
      const r = validateSchema({
        a: { type: "blob" },
        b: { type: "array" },
        c: { type: "number", enum: ["x"] },
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.errors).toHaveLength(3);
        expect(r.errors.map((e) => e.path).sort()).toEqual(["a", "b", "c"]);
      }
    });
  });

  describe("realistic schemas", () => {
    it("accepts the recipe schema from the example app", () => {
      expect(
        validateSchema({
          name: { type: "string", description: "Recipe name" },
          ingredients: { type: "array", items: { type: "string" } },
          steps: { type: "array", items: { type: "string" } },
          difficulty: {
            type: "string",
            enum: ["easy", "medium", "hard"],
          },
        }),
      ).toEqual({ ok: true });
    });
  });
});

describe("SchemaInvalidError", () => {
  it("carries the validation errors and formats a readable message", () => {
    const err = new SchemaInvalidError([
      { path: "x", message: "bad" },
      { path: "y.items", message: "worse" },
    ]);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("SchemaInvalidError");
    expect(err.errors).toHaveLength(2);
    expect(err.message).toContain("x: bad");
    expect(err.message).toContain("y.items: worse");
  });
});
