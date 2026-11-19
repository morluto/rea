import { Ajv2020 } from "ajv/dist/2020.js";

import {
  schemaArrays as schemaArrayKeywords,
  schemaChildren as schemaChildKeywords,
  schemaMaps as schemaMapKeywords,
} from "../../src/contracts/jsonSchemaKeywords.js";
import { arrayItemSchemaError } from "./mcpClientSchemaConstraints.js";

/** Advertised schema pair as a client receives it from `tools/list`. */
interface AdvertisedToolSchemas {
  readonly name: string;
  readonly inputSchema: Record<string, unknown>;
  readonly outputSchema?: Record<string, unknown> | undefined;
}

/**
 * Validate registered schemas: Ajv's declared-dialect meta-schema and
 * reference resolution, then array `items`. Compiling catches a projection
 * that drops a referenced definition or leaves a local `$ref` without its
 * target, which a byte-budget assertion alone would not. Literal portability
 * belongs to the advertised dialect projection, so it is checked on the
 * schemas a served catalog lists, not here.
 */
export function advertisedSchemaErrors(
  tools: readonly AdvertisedToolSchemas[],
): string[] {
  // Reuse Ajv's meta-schema validators, then clear each root's reference
  // namespace, including nested IDs, before validating the next schema.
  const ajv = new Ajv2020({
    strict: false,
    validateFormats: false,
    addUsedSchema: false,
    // Keep shared definitions as compiled functions instead of expanding them
    // at every reference, while still compiling every $ref target.
    inlineRefs: false,
    // This check compiles schemas to detect invalid references but never runs
    // their validators. Generated-code optimization adds substantial work here
    // without checking another contract; actual SDK validators keep defaults.
    code: { optimize: false },
  });
  return tools.flatMap((tool) =>
    ["inputSchema", "outputSchema"].flatMap((kind) => {
      const schema =
        kind === "inputSchema" ? tool.inputSchema : tool.outputSchema;
      if (schema === undefined) return [];
      try {
        if (!ajv.validateSchema(schema))
          return [`${tool.name}.${kind}: ${ajv.errorsText(ajv.errors)}`];
        ajv.compile(schema);
        const clientError = arrayItemSchemaError(
          schema,
          `${tool.name}.${kind}`,
        );
        if (clientError !== undefined) return [clientError];
        return [];
      } catch (cause: unknown) {
        return [
          `${tool.name}.${kind}: ${cause instanceof Error ? cause.message : String(cause)}`,
        ];
      } finally {
        ajv.removeSchema();
      }
    }),
  );
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Resolve a local JSON Pointer reference inside one schema document. */
export function resolveReference(schema: unknown, reference: string): unknown {
  if (reference === "#") return schema;
  if (!reference.startsWith("#/")) return undefined;
  let value = schema;
  for (const token of reference.slice(2).split("/")) {
    const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
    if (
      typeof value !== "object" ||
      value === null ||
      !Object.hasOwn(value, key)
    )
      return undefined;
    value = Reflect.get(value, key);
  }
  return value;
}

/** Local `$ref` cycles in each advertised schema; clients reject recursion. */
export function recursiveReferences(
  tools: readonly AdvertisedToolSchemas[],
): string[] {
  return tools.flatMap((tool) =>
    (["inputSchema", "outputSchema"] as const).flatMap((kind) => {
      const schema = tool[kind];
      const found = new Set<string>();
      const visit = (node: unknown, active: readonly string[]): void => {
        if (typeof node !== "object" || node === null) return;
        for (const [key, child] of Object.entries(node)) {
          if (
            [
              "$defs",
              "definitions",
              "examples",
              "default",
              "const",
              "enum",
            ].includes(key)
          )
            continue;
          if (key !== "$ref" || typeof child !== "string") visit(child, active);
          else if (active.includes(child)) found.add(child);
          else visit(resolveReference(schema, child), [...active, child]);
        }
      };
      visit(schema, []);
      return [...found].map(
        (reference) => `${tool.name}.${kind}: ${reference}`,
      );
    }),
  );
}

/** Local `$ref`s in input schema positions, which some clients cannot resolve. */
export function localInputReferences(
  tools: readonly AdvertisedToolSchemas[],
): string[] {
  return tools.flatMap((tool) => {
    const references: string[] = [];
    const visit = (node: unknown, path: string): void => {
      if (!isRecord(node)) return;
      if (typeof node.$ref === "string") references.push(`${path}.$ref`);
      for (const [key, value] of Object.entries(node)) {
        if (schemaMapKeywords.has(key) && isRecord(value)) {
          for (const [name, schema] of Object.entries(value))
            visit(schema, `${path}.${key}.${name}`);
        } else if (schemaArrayKeywords.has(key) && Array.isArray(value)) {
          value.forEach((schema, index) =>
            visit(schema, `${path}.${key}[${index}]`),
          );
        } else if (schemaChildKeywords.has(key)) {
          if (Array.isArray(value))
            value.forEach((schema, index) =>
              visit(schema, `${path}.${key}[${index}]`),
            );
          else visit(value, `${path}.${key}`);
        }
      }
    };
    visit(tool.inputSchema, `${tool.name}.inputSchema`);
    return references;
  });
}
