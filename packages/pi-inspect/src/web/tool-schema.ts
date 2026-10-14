import type { Json } from "../model.js";
import { record } from "./format.js";

export interface SchemaNode {
  id: string;
  name: string;
  type: string;
  required?: boolean | "unknown";
  description: string;
  annotations: [string, Json][];
  children: SchemaNode[];
  limited: boolean;
}
const structural = new Set([
  "type",
  "description",
  "properties",
  "required",
  "items",
  "prefixItems",
  "additionalProperties",
  "patternProperties",
  "anyOf",
  "oneOf",
  "allOf",
  "not",
  "if",
  "then",
  "else",
  "$defs",
  "definitions",
]);
function schemaType(value: Json): string {
  if (value === true) return "any";
  if (value === false) return "never";
  const schema = record(value);
  if (!schema) return "unspecified";
  if (typeof schema.type === "string") return schema.type;
  if (Array.isArray(schema.type)) return schema.type.filter((type) => typeof type === "string").join(" | ");
  if (schema.$ref) return "reference";
  if (schema.anyOf || schema.oneOf || schema.allOf) return "composition";
  return "unspecified";
}

interface RequiredProperties {
  names: Set<string>;
  unresolved: boolean;
}
// Resolve only unconditional required/allOf declarations at the same instance.
// References and other assertions can require fields; their absence from a local
// required array is not sufficient evidence to label a parameter optional.
function requiredProperties(value: Json, depth = 0, budget = { remaining: 2000 }): RequiredProperties {
  const schema = record(value);
  const names = new Set(
    Array.isArray(schema?.required) ? schema.required.filter((name): name is string => typeof name === "string") : [],
  );
  if (--budget.remaining < 0 || depth >= 32) return { names, unresolved: true };
  if (!schema) return { names, unresolved: value !== true };
  let unresolved = [
    "$ref",
    "$dynamicRef",
    "$recursiveRef",
    "anyOf",
    "oneOf",
    "not",
    "if",
    "then",
    "else",
    "dependentRequired",
    "dependentSchemas",
    "dependencies",
    "minProperties",
    "const",
    "enum",
  ].some((keyword) => schema[keyword] !== undefined);
  if (schema.required !== undefined && !Array.isArray(schema.required)) unresolved = true;
  if (schema.allOf !== undefined) {
    if (!Array.isArray(schema.allOf)) unresolved = true;
    else
      for (const part of schema.allOf) {
        const child = requiredProperties(part, depth + 1, budget);
        for (const name of child.names) names.add(name);
        unresolved ||= child.unresolved;
        if (budget.remaining <= 0) {
          unresolved = true;
          break;
        }
      }
  }
  return { names, unresolved };
}

// Limit documentation work, never the stored declaration. Keep references and
// composition branches explicit rather than rewriting or flattening the schema.
export function parseSchema(value: Json): SchemaNode {
  let remaining = 2000;
  function parse(
    value: Json,
    name: string,
    required?: SchemaNode["required"],
    depth = 0,
    inherited?: RequiredProperties,
  ): SchemaNode {
    const schema = record(value);
    const node: SchemaNode = {
      id: `${remaining}:${name}`,
      name,
      type: schemaType(value),
      required,
      description: typeof schema?.description === "string" ? schema.description : "",
      annotations: [],
      children: [],
      limited: false,
    };
    if (--remaining < 0 || depth >= 32) {
      node.limited = true;
      return node;
    }
    if (!schema) {
      if (typeof value !== "boolean") node.annotations.push(["Unrecognized schema", value]);
      return node;
    }
    node.annotations = Object.entries(schema).filter(([key]) => !structural.has(key));
    const requirements = requiredProperties(value);
    if (inherited) {
      for (const name of inherited.names) requirements.names.add(name);
      requirements.unresolved ||= inherited.unresolved;
    }
    function child(value: Json, label: string, required?: SchemaNode["required"], inherited?: RequiredProperties) {
      if (remaining <= 0) {
        node.limited = true;
        return;
      }
      node.children.push(parse(value, label, required, depth + 1, inherited));
    }
    for (const [key, property] of Object.entries(record(schema.properties) ?? {})) {
      child(property, key, requirements.names.has(key) ? true : requirements.unresolved ? "unknown" : false);
    }
    if (schema.required !== undefined) node.annotations.push(["required", schema.required]);
    for (const keyword of ["patternProperties", "$defs", "definitions"]) {
      for (const [key, property] of Object.entries(record(schema[keyword]) ?? {}))
        child(property, `${keyword}: ${key}`);
    }
    for (const keyword of ["items", "prefixItems", "anyOf", "oneOf", "allOf"]) {
      const part = schema[keyword];
      if (part === undefined) continue;
      if (Array.isArray(part))
        part.forEach((item, index) => {
          child(
            item,
            `${keyword} [${index + 1}]`,
            undefined,
            ["allOf", "anyOf", "oneOf"].includes(keyword) ? requirements : undefined,
          );
        });
      else child(part, keyword === "items" ? "items []" : keyword);
    }
    for (const keyword of ["additionalProperties", "not", "if", "then", "else"]) {
      if (schema[keyword] !== undefined)
        child(schema[keyword], keyword, undefined, ["if", "then", "else"].includes(keyword) ? requirements : undefined);
    }
    return node;
  }
  return parse(value, "Input");
}

function documentedReturn(codemode: string): string | undefined {
  const result = /\btools\.[\w$]+\(args\)`? resolves to[ \t]+([^\n]+)(?:\n|$)/.exec(codemode);
  let type = result?.[1]?.trim().replace(/\.$/, "");
  if (type?.startsWith("`")) {
    if (!type.endsWith("`") || type.length < 2) return undefined;
    type = type.slice(1, -1);
  } else type = type?.replace(/`$/, "");
  if (!type || /[|&,:]$/.test(type)) return undefined;
  // A wrapped/incomplete type is still readable in Codemode documentation, but
  // must not be presented as a complete return declaration.
  for (const [open, close] of [
    ["{", "}"],
    ["[", "]"],
    ["(", ")"],
  ] as const) {
    if (type.split(open).length !== type.split(close).length) return undefined;
  }
  return type;
}

export interface ToolDoc {
  id: number;
  name: string;
  description: string;
  codemode: string;
  returns?: Json;
  parameters?: Json;
  examples: { id: string; value: Json }[];
  raw: Json;
}
export function toolDocuments(value: Json | undefined): ToolDoc[] {
  if (!Array.isArray(value)) return [];
  return value.map((raw, id) => {
    const tool = record(raw);
    const description = typeof tool?.description === "string" ? tool.description : "";
    const marker = /(?:^|\n)[ \t]*Codemode:[ \t]*/i.exec(description);
    const codemode = marker ? description.slice(marker.index + marker[0].length).trim() : "";
    return {
      id,
      name: typeof tool?.name === "string" && tool.name ? tool.name : `Unnamed tool ${id + 1}`,
      description: marker ? description.slice(0, marker.index).trimEnd() : description,
      codemode,
      returns: tool?.outputSchema ?? tool?.returnType ?? documentedReturn(codemode),
      parameters: tool?.parameters ?? tool?.inputSchema,
      examples: Array.isArray(tool?.examples)
        ? tool.examples.map((value, index) => ({ id: `example-${index}`, value }))
        : [],
      raw,
    };
  });
}
