import { describe, it } from "node:test";

import { RuleTester } from "oxlint/plugins-dev";

import antiSlopPlugin from "./index.ts";

import type { Rule } from "@oxlint/plugins";

RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({
	languageOptions: { parserOptions: { lang: "ts" } },
});

function rule(name: string): Rule {
	const selected = antiSlopPlugin.rules?.[name];
	if (selected === undefined) throw new Error(`Missing anti-slop rule: ${name}`);
	return selected;
}

ruleTester.run("no-chained-type-assertions", rule("no-chained-type-assertions"), {
	valid: ['const value = "known" as string;'],
	invalid: [
		{
			code: 'const value = ("known" as unknown) as string;',
			errors: [{ messageId: "chained" }],
		},
	],
});

ruleTester.run(
	"no-conditional-empty-object-spread",
	rule("no-conditional-empty-object-spread"),
	{
		valid: ["const value = { ...(flag ? { enabled: true } : { disabled: true }) };"],
		invalid: [
			{
				code: "const value = { ...(flag ? { enabled: true } : {}) };",
				errors: [{ messageId: "avoid" }],
			},
		],
	},
);

ruleTester.run("no-known-value-widening", rule("no-known-value-widening"), {
	valid: [
		'const value: string = "known";',
		"function inspect(value: unknown): value is string { return true; }\nfunction parse(value: unknown) { inspect(value); }",
	],
	invalid: [
		{
			code: 'const value: unknown = "known";',
			errors: [{ messageId: "widening" }],
		},
		{
			code: "function inspect(value: unknown): value is string { return true; }\nconst known = \"value\";\ninspect(known);",
			errors: [{ messageId: "widening" }],
		},
	],
});

ruleTester.run("no-module-mocking", rule("no-module-mocking"), {
	valid: ["const jest = { mock() {} }; jest.mock('./module');"],
	invalid: [
		{
			code: "jest.mock('./module');",
			errors: [{ messageId: "moduleMock" }],
		},
	],
});

ruleTester.run("no-object-parameters", rule("no-object-parameters"), {
	valid: [
		"function read(value: { id: string }): string { return value.id; }",
		"type Broad = object; function preserve<Broad>(value: Broad): Broad { return value; }",
	],
	invalid: [
		{
			code: "type Broad = object; function read(value: Broad): void {}",
			errors: [{ messageId: "objectParameter" }],
		},
	],
});

ruleTester.run("no-reflect-apply", rule("no-reflect-apply"), {
	valid: ["const Reflect = { apply() {} }; Reflect.apply();"],
	invalid: [
		{
			code: "Reflect.apply(handler, null, []);",
			errors: [{ messageId: "reflectApply" }],
		},
	],
});

ruleTester.run("no-reflect-get", rule("no-reflect-get"), {
	valid: ["const Reflect = { get() {} }; Reflect.get();"],
	invalid: [
		{
			code: "Reflect.get(value, 'field');",
			errors: [{ messageId: "reflectGet" }],
		},
	],
});

ruleTester.run("no-runtime-typeof", rule("no-runtime-typeof"), {
	valid: ['if (typeof optional === "undefined") {}'],
	invalid: [
		{
			code: 'if (typeof value === "string") {}',
			errors: [{ messageId: "runtimeTypeof" }],
		},
	],
});

ruleTester.run("no-shape-in-symbol-names", rule("no-shape-in-symbol-names"), {
	valid: ["schema.shape;"],
	invalid: [
		{
			code: "const responseShape = {};",
			errors: [{ messageId: "forbiddenSymbolName" }],
		},
	],
});

ruleTester.run("no-unknown-parameters", rule("no-unknown-parameters"), {
	valid: [
		"function isText(value: unknown): value is string { return true; }",
		"function enrich(cause: unknown): void {}",
	],
	invalid: [
		{
			code: "function parse(value: unknown): void {}",
			errors: [{ messageId: "unknownParameter" }],
		},
	],
});

ruleTester.run("no-unknown-returns", rule("no-unknown-returns"), {
	valid: ["function load(): string { return 'value'; }"],
	invalid: [
		{
			code: "type Result = unknown; function load(): Promise<Result> { throw new Error(); }",
			errors: [{ messageId: "unknownReturn" }],
		},
	],
});

ruleTester.run("no-unknown-type-aliases", rule("no-unknown-type-aliases"), {
	valid: ["type Value = string;"],
	invalid: [
		{
			code: "type Input = unknown; type Value = Input | string;",
			errors: [
				{ messageId: "unknownAlias" },
				{ messageId: "unknownAlias" },
			],
		},
	],
});

ruleTester.run("no-unsafe-dictionary-type", rule("no-unsafe-dictionary-type"), {
	valid: [
		"type Safe = Record<string, string>;",
		"const Local = class Record { value!: Record; }; void Local;",
		"class Record {} type Safe = Record;",
	],
	invalid: [
		{
			code: "type Unsafe = Record<string, unknown>;",
			errors: [{ messageId: "unsafeDictionary" }],
		},
		{
			name: "a named class expression before a reference does not shadow the built-in",
			code: "const Local = class Record {}; type Unsafe = Record<string, unknown>; void Local;",
			errors: [{ messageId: "unsafeDictionary" }],
		},
		{
			name: "a named class expression after a reference does not shadow the built-in",
			code: "type Unsafe = Record<string, unknown>; const Local = class Record {}; void Local;",
			errors: [{ messageId: "unsafeDictionary" }],
		},
		{
			name: "a named class expression does not hide an outer type alias",
			code: "type Record<Key extends PropertyKey, Value> = { [Property in Key]: Value }; const Local = class Record {}; type Unsafe = Record<string, unknown>; void Local;",
			errors: [{ messageId: "unsafeDictionary" }],
		},
	],
});

ruleTester.run("no-widen-then-assert", rule("no-widen-then-assert"), {
	valid: ["const value = { id: 'known' }; const result = value;"],
	invalid: [
		{
			code: "const value: unknown = { id: 'known' }; const result = value as { id: string };",
			errors: [{ messageId: "widenThenAssert" }],
		},
	],
});

ruleTester.run(
	"require-safety-comment-for-type-assertion",
	rule("require-safety-comment-for-type-assertion"),
	{
		valid: [
			"// SAFETY: validated by the schema\nconst value = input as string;",
			{
				code: "// INVARIANT: validated by the schema\nconst value = input as string;",
				options: [{ markers: ["INVARIANT"] }],
			},
		],
		invalid: [
			{
				code: "const value = input as string;",
				errors: [{ messageId: "missingSafetyComment" }],
			},
		],
	},
);
