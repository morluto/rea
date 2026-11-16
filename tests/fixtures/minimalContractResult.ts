import { Ajv2020 } from "ajv/dist/2020.js";
import { z } from "zod";

import type { ToolContract } from "../../src/contracts/toolContractTypes.js";
import type { JsonValue } from "../../src/domain/jsonValue.js";

type Schema = Readonly<Record<string, unknown>> | boolean;

/** Strings tried, in order, against a pattern or format. */
const STRING_CANDIDATES = [
  "0x1000",
  "fixture",
  "0",
  "a",
  "x86",
  "ram:0x1000",
  "f".repeat(64),
  "2026-01-01T00:00:00.000Z",
  "/fixture",
  "file:///fixture",
  "https://fixture.invalid/",
  "1.0.0",
  "",
];

const ajv = new Ajv2020({
  strict: false,
  allErrors: false,
  validateFormats: false,
});

type Root = Readonly<Record<string, unknown>>;
type Node = Readonly<Record<string, unknown>>;

/**
 * The smallest instance the generator can build for one JSON Schema: required
 * properties only, minimum array lengths, and the first branch that validates.
 * Returns undefined when no candidate satisfies the schema.
 */
const instance = (
  schema: Schema,
  root: Root,
  depth = 0,
): JsonValue | undefined => {
  if (depth > 40 || schema === false) return undefined;
  if (schema === true) return null;
  if (typeof schema.$ref === "string")
    return referenced(schema.$ref, root, depth);
  if ("const" in schema) return schema.const as JsonValue;
  if (Array.isArray(schema.enum)) return schema.enum[0] as JsonValue;
  for (const key of ["anyOf", "oneOf"] as const)
    if (Array.isArray(schema[key])) return branch(schema, key, root, depth);
  if (Array.isArray(schema.allOf))
    return instance(intersection(schema), root, depth + 1);
  return typed(schema, root, depth);
};

/** An instance of a schema selected by its `type` keyword alone. */
const typed = (
  schema: Node,
  root: Root,
  depth: number,
): JsonValue | undefined => {
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  if (type === "null") return null;
  if (type === "boolean") return false;
  if (type === "integer" || type === "number") return number(schema);
  if (type === "string") return string(schema);
  if (type === "array") return array(schema, root, depth);
  if (type === "object" || (type === undefined && "properties" in schema))
    return object(schema, root, depth);
  return type === undefined ? null : undefined;
};

/** One schema with every `allOf` member's properties and requirements. */
const intersection = (schema: Node): Record<string, unknown> =>
  (schema.allOf as Schema[]).reduce<Record<string, unknown>>(
    (all, part) => (typeof part === "object" ? mergeSchemas(all, part) : all),
    withoutKey(schema, "allOf"),
  );

const referenced = (
  ref: string,
  root: Root,
  depth: number,
): JsonValue | undefined => {
  const defs = root.$defs as Record<string, Schema> | undefined;
  const target = ref === "#" ? root : defs?.[ref.replace(/^#\/\$defs\//u, "")];
  return target === undefined ? undefined : instance(target, root, depth + 1);
};

const branch = (
  schema: Node,
  key: "anyOf" | "oneOf",
  root: Root,
  depth: number,
): JsonValue | undefined => {
  for (const option of schema[key] as Schema[]) {
    const value = instance(
      typeof option === "object"
        ? { ...withoutKey(schema, key), ...option }
        : option,
      root,
      depth + 1,
    );
    if (value !== undefined && validates(schema, root, value)) return value;
  }
  return undefined;
};

const number = (schema: Node): number =>
  Math.ceil(
    typeof schema.minimum === "number"
      ? schema.minimum
      : typeof schema.exclusiveMinimum === "number"
        ? schema.exclusiveMinimum + 1
        : 0,
  );

const string = (schema: Node): string | undefined => {
  const minLength = typeof schema.minLength === "number" ? schema.minLength : 0;
  const maxLength =
    typeof schema.maxLength === "number" ? schema.maxLength : Infinity;
  const pattern =
    typeof schema.pattern === "string"
      ? new RegExp(schema.pattern, "u")
      : undefined;
  return STRING_CANDIDATES.map((candidate) =>
    candidate.padEnd(minLength, "a"),
  ).find(
    (candidate) =>
      candidate.length <= maxLength &&
      (pattern === undefined || pattern.test(candidate)),
  );
};

const array = (
  schema: Node,
  root: Root,
  depth: number,
): JsonValue[] | undefined => {
  const minItems = typeof schema.minItems === "number" ? schema.minItems : 0;
  const prefix = Array.isArray(schema.prefixItems)
    ? (schema.prefixItems as Schema[])
    : [];
  const values: JsonValue[] = [];
  for (let index = 0; index < Math.max(minItems, prefix.length); index++) {
    const item = instance(
      prefix[index] ?? (schema.items as Schema | undefined) ?? true,
      root,
      depth + 1,
    );
    if (item === undefined) return undefined;
    values.push(item);
  }
  return values;
};

const object = (
  schema: Node,
  root: Root,
  depth: number,
): Record<string, JsonValue> | undefined => {
  const properties = (schema.properties ?? {}) as Record<string, Schema>;
  const value: Record<string, JsonValue> = {};
  for (const key of (schema.required ?? []) as string[]) {
    const member = instance(properties[key] ?? true, root, depth + 1);
    if (member === undefined) return undefined;
    value[key] = member;
  }
  return value;
};

const withoutKey = (
  schema: Readonly<Record<string, unknown>>,
  key: string,
): Record<string, unknown> =>
  Object.fromEntries(Object.entries(schema).filter(([name]) => name !== key));

const mergeSchemas = (
  left: Record<string, unknown>,
  right: Readonly<Record<string, unknown>>,
): Record<string, unknown> => ({
  ...left,
  ...right,
  ...(left.properties !== undefined || right.properties !== undefined
    ? {
        properties: {
          ...(left.properties as object | undefined),
          ...(right.properties as object | undefined),
        },
      }
    : {}),
  ...(left.required !== undefined || right.required !== undefined
    ? {
        required: [
          ...((left.required as string[] | undefined) ?? []),
          ...((right.required as string[] | undefined) ?? []),
        ],
      }
    : {}),
});

const validates = (
  schema: Readonly<Record<string, unknown>>,
  root: Readonly<Record<string, unknown>>,
  value: JsonValue,
): boolean => {
  try {
    return ajv.validate({ ...schema, $defs: root.$defs }, value) === true;
  } catch {
    return false;
  }
};

/**
 * A minimal `normalized_result` that the contract's canonical output schema
 * admits, or undefined when the generator cannot satisfy it.
 */
export const minimalContractResult = (
  contract: Pick<ToolContract, "outputSchema">,
): JsonValue | undefined => {
  const root = z.toJSONSchema(contract.outputSchema, {
    io: "output",
    unrepresentable: "any",
  }) as Record<string, unknown>;
  const result = (root.properties as Record<string, Schema> | undefined)
    ?.normalized_result;
  if (result === undefined) return undefined;
  const value = instance(result, root);
  if (value === undefined) return undefined;
  return typeof result === "object" && !validates(result, root, value)
    ? undefined
    : value;
};

/** A minimal input the contract's input schema admits, when one can be built. */
export const minimalContractInput = (
  contract: Pick<ToolContract, "inputSchema">,
): Readonly<Record<string, JsonValue>> | undefined => {
  const root = z.toJSONSchema(contract.inputSchema, {
    io: "input",
    unrepresentable: "any",
  }) as Record<string, unknown>;
  const value = instance(root, root);
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return undefined;
  return contract.inputSchema.safeParse(value).success ? value : undefined;
};
