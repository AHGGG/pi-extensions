import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import type { Json } from "../src/model.js";
import { capture } from "../src/privacy.js";
import { ParameterSchema } from "../src/web/tool-inspector.js";
import { parseSchema, toolDocuments } from "../src/web/tool-schema.js";
import { runtimeToolDeclarations } from "./fixtures.js";

describe("tool schema documentation", () => {
  it("preserves requiredness, nullable types, array items, enums, and constraints", () => {
    const root = parseSchema({
      type: "object",
      required: ["steps"],
      properties: {
        path: { type: ["string", "null"], description: "Path\nSecond line", default: null },
        steps: {
          type: "array",
          maxItems: 50,
          items: {
            type: "object",
            required: ["text", "status"],
            properties: {
              text: { type: "string", minLength: 1, maxLength: 503 },
              status: { type: "string", enum: ["pending", "in_progress", "completed", "blocked"] },
            },
          },
        },
      },
    });
    const [path, steps] = root.children;
    expect(path).toMatchObject({ type: "string | null", required: false, description: "Path\nSecond line" });
    expect(path?.annotations).toContainEqual(["default", null]);
    expect(steps?.required).toBe(true);
    expect(steps?.annotations).toContainEqual(["maxItems", 50]);
    expect(steps?.children[0]?.name).toBe("items []");
    expect(steps?.children[0]?.children[1]?.annotations).toContainEqual([
      "enum",
      ["pending", "in_progress", "completed", "blocked"],
    ]);
  });
  it("resolves nested allOf requirements across same-instance branches without leaking into child objects", () => {
    const schema: Record<string, Json> = {
      type: "object",
      required: ["sibling"],
      properties: {
        path: { type: "string" },
        optional: { type: "string" },
        nested: { type: "object", properties: { path: { type: "string" } } },
      },
      allOf: [{ allOf: [{ required: ["path"] }] }, { properties: { sibling: { type: "string" } } }],
    };
    const root = parseSchema(schema);
    expect(root.children.find((node) => node.name === "path")?.required).toBe(true);
    expect(root.children.find((node) => node.name === "optional")?.required).toBe(false);
    expect(root.children.find((node) => node.name === "nested")?.children[0]?.required).toBe(false);
    expect(root.children.find((node) => node.name === "allOf [2]")?.children[0]?.required).toBe(true);
    expect(Value.Check(schema, { sibling: "value" })).toBe(false);
    expect(Value.Check(schema, { sibling: "value", path: "file.txt" })).toBe(true);
  });
  it("inherits surrounding requiredness into positive conditional branches", () => {
    const root = parseSchema({
      required: ["path"],
      if: { properties: { path: { type: "string" } } },
      // biome-ignore lint/suspicious/noThenProperty: JSON Schema conditional keyword, not a thenable.
      then: { properties: { path: { type: "string" } } },
      else: { properties: { path: { type: "number" } } },
    });
    for (const branch of root.children) expect(branch.children[0]?.required).toBe(true);
  });
  it.each<Record<string, Json>>([
    { $ref: "#/$defs/required" },
    { $dynamicRef: "#required" },
    { $recursiveRef: "#" },
    { anyOf: [{ required: ["maybe"] }, {}] },
    { oneOf: [{ required: ["maybe"] }, {}] },
    { not: { not: { required: ["maybe"] } } },
    { dependentRequired: { known: ["maybe"] } },
    { dependentSchemas: { known: { required: ["maybe"] } } },
    { dependencies: { known: ["maybe"] } },
    {
      if: { required: ["known"] },
      // biome-ignore lint/suspicious/noThenProperty: JSON Schema conditional keyword, not a thenable.
      then: { required: ["maybe"] },
    },
    { minProperties: 2 },
    { const: { known: "value", maybe: "value" } },
    { enum: [{ known: "value", maybe: "value" }] },
    { allOf: [{ $ref: "#/$defs/required" }] },
  ])("does not assert optionality for unresolved same-object constraints: %j", (constraint) => {
    const root = parseSchema({
      type: "object",
      required: ["known"],
      properties: { known: { type: "string" }, maybe: { type: "string" } },
      ...constraint,
    });
    expect(root.children.find((node) => node.name === "known")?.required).toBe(true);
    expect(root.children.find((node) => node.name === "maybe")?.required).toBe("unknown");
    const html = renderToStaticMarkup(
      createElement(ParameterSchema, {
        value: {
          type: "object",
          properties: { maybe: { type: "string" } },
          ...constraint,
        },
      }),
    );
    expect(html).toContain(">Unknown<");
  });
  it("keeps requiredness unresolved when allOf traversal reaches a documentation limit", () => {
    let clause: Json = { required: ["path"] };
    for (let i = 0; i < 40; i++) clause = { allOf: [clause] };
    const root = parseSchema({ properties: { path: { type: "string" } }, allOf: [clause] });
    expect(root.children[0]?.required).toBe("unknown");
    const clauses: Json[] = Array.from({ length: 2500 }, () => true);
    clauses.push({ required: ["path"] });
    const wide = parseSchema({ properties: { path: { type: "string" } }, allOf: clauses });
    expect(wide.children[0]?.required).toBe("unknown");
    expect(wide.limited).toBe(true);
  });
  it.each<Record<string, Json>>([
    { properties: { path: { type: "string" } } },
    { items: { type: "string" } },
    { prefixItems: [{ type: "string" }] },
  ])("does not infer exclusive types from structural constraints: %j", (schema) => {
    expect(parseSchema(schema).type).toBe("unspecified");
    expect(Value.Check(schema, 42)).toBe(true);
    expect(Value.Check(schema, "text")).toBe(true);
    expect(parseSchema({ ...schema, type: ["object", "null"] }).type).toBe("object | null");
  });
  it("keeps composition branches, tuples, references, maps and boolean schemas separate", () => {
    const root = parseSchema({
      allOf: [{ properties: { a: { $ref: "#/$defs/text" } } }, { additionalProperties: false }],
      anyOf: [{ type: "null" }, { type: "object" }],
      oneOf: [{ const: 1 }, { const: 2 }],
      prefixItems: [{ type: "string" }, true],
      items: false,
      additionalProperties: { type: "number" },
      patternProperties: { "^x": { type: "boolean" } },
      $defs: { text: { type: "string" } },
      not: { type: "integer" },
      if: { const: 1 },
      // biome-ignore lint/suspicious/noThenProperty: JSON Schema conditional keyword, not a thenable.
      then: true,
      else: false,
      dependentRequired: { a: ["b"] },
    });
    expect(root.children.map((node) => node.name)).toEqual([
      "patternProperties: ^x",
      "$defs: text",
      "items []",
      "prefixItems [1]",
      "prefixItems [2]",
      "anyOf [1]",
      "anyOf [2]",
      "oneOf [1]",
      "oneOf [2]",
      "allOf [1]",
      "allOf [2]",
      "additionalProperties",
      "not",
      "if",
      "then",
      "else",
    ]);
    expect(root.children.find((node) => node.name === "allOf [1]")?.children[0]?.annotations).toContainEqual([
      "$ref",
      "#/$defs/text",
    ]);
    expect(root.annotations).toContainEqual(["dependentRequired", { a: ["b"] }]);
    expect(parseSchema(false).type).toBe("never");
    expect(parseSchema(true).type).toBe("any");
    expect(parseSchema("unsupported").annotations).toContainEqual(["Unrecognized schema", "unsupported"]);
  });
  it("bounds large and deep schemas with a visible fallback, without mutating input", () => {
    const large = {
      properties: Object.fromEntries(Array.from({ length: 2500 }, (_, i) => [`p${i}`, { type: "string" }])),
    };
    const before = JSON.stringify(large);
    const root = parseSchema(large);
    expect(root.limited).toBe(true);
    expect(root.children).toHaveLength(1999);
    expect(JSON.stringify(large)).toBe(before);
    let deep: Json = { type: "string" };
    for (let i = 0; i < 100; i++) deep = { items: deep };
    let node = parseSchema(deep);
    for (let i = 0; i < 32; i++) node = node.children[0] as typeof node;
    expect(node.limited).toBe(true);
  });
  it("renders readable tables with optional parameters and escaped metadata without mounting closed descendants", () => {
    const html = renderToStaticMarkup(
      createElement(ParameterSchema, {
        value: {
          type: "object",
          required: ["path"],
          properties: {
            path: { type: "string", description: "<script>\nread a file" },
            offset: { type: "number", minimum: 1 },
            edits: { type: "array", items: { properties: { oldText: { type: "string" } } } },
          },
        },
      }),
    );
    expect(html).toContain("Input parameters");
    expect(html).toContain(">Yes<");
    expect(html).toContain(">No<");
    expect(html).toContain("&lt;script&gt;\nread a file");
    expect(html).toContain("minimum:");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("oldText");
  });
});
describe("declaration documentation", () => {
  it("separates documented Codemode returns while retaining complete original descriptions", () => {
    const raw = {
      name: "read",
      description:
        'Read a file.\n\nKeep paragraphs.\n\nCodemode: `tools.read(args) resolves to string | { type: "image" }`.',
      parameters: {},
    };
    const doc = toolDocuments([raw])[0];
    expect(doc?.description).toBe("Read a file.\n\nKeep paragraphs.");
    expect(doc?.codemode).toContain("tools.read(args)");
    expect(doc?.returns).toBe('string | { type: "image" }');
    expect(doc?.raw).toBe(raw);
  });
  it("extracts string, object, and union return information from Pi-generated descriptions", () => {
    const docs = toolDocuments(capture(runtimeToolDeclarations()).value);
    expect(docs.find((tool) => tool.name === "read")?.returns).toContain("string | {");
    expect(docs.find((tool) => tool.name === "bash")?.returns).toContain("exit_code");
    expect(docs.find((tool) => tool.name === "edit")?.returns).toBe("a string");
    expect(docs.find((tool) => tool.name === "$custom-tool")?.returns).toBe("Array<string>");
    for (const tool of docs) {
      expect(tool.codemode).toMatch(/\btools\.[\w$]+\(args\)`/);
      expect(tool.returns).not.toMatch(/`/);
    }
  });
  it.each([
    ["tools.custom(args) resolves to string.", "string"],
    ["`tools.custom(args)` resolves to `string`.", "string"],
    ["`tools.custom(args)` resolves to a string.", "a string"],
    ["`tools.$custom_tool(args)` resolves to `string[]`.", "string[]"],
    ["`tools.custom(args) resolves to string`.", "string"],
    ["`tools.custom(args)` resolves to `{ value: string; }`.", "{ value: string; }"],
    ["`tools.custom(args)` resolves to `string", undefined],
    ["`tools.custom(args)` resolves to `string | {`.", undefined],
    ["`tools.custom(args)` resolves to `string |`.", undefined],
  ])("normalizes documented return delimiters without accepting incomplete types: %s", (source, expected) => {
    expect(toolDocuments([{ name: "custom", description: `Codemode: ${source}` }])[0]?.returns).toBe(expected);
  });
  it("does not promote an incomplete multiline return type to a return declaration", () => {
    const [doc] = toolDocuments([
      { name: "read", description: "Codemode: tools.read(args) resolves to string | {\n data: string\n}" },
    ]);
    expect(doc?.returns).toBeUndefined();
    expect(doc?.codemode).toContain("data: string");
  });
  it("handles incomplete metadata and arbitrary declarations without inventing examples or return schemas", () => {
    const docs = toolDocuments([
      {},
      null,
      { name: "bash", description: "Returns command output" },
      { name: "custom", returnType: "string", examples: [{ value: 1 }] },
    ]);
    expect(docs[0]?.name).toBe("Unnamed tool 1");
    expect(docs[1]?.parameters).toBeUndefined();
    expect(docs[2]?.returns).toBeUndefined();
    expect(docs[2]?.examples).toEqual([]);
    expect(docs[3]?.returns).toBe("string");
    expect(docs[3]?.examples).toEqual([{ id: "example-0", value: { value: 1 } }]);
    expect(toolDocuments("unavailable")).toEqual([]);
  });
});
