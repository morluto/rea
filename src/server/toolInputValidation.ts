import { z } from "zod";

import {
  AnalysisInputError,
  type AnalysisInputIssue,
} from "../domain/errors.js";
import { projectInputIssues } from "../domain/inputIssueProjection.js";
import { err, ok, type Result } from "../domain/result.js";
import { closeObjectSchemas } from "./toolRegistrationOptions.js";

/** Parse one MCP request exactly once and retain only schema-owned correction data. */
export const safeParseToolInput = <Schema extends z.ZodType>(
  schema: Schema,
  input: unknown,
  operation: string,
): Result<z.output<Schema>, AnalysisInputError> => {
  const unknownIssues = unknownArgumentIssues(schema, input);
  if (unknownIssues.length > 0)
    return err(new AnalysisInputError(operation, undefined, unknownIssues));
  const parsed = schema.safeParse(input);
  return parsed.success
    ? ok(parsed.data)
    : err(
        new AnalysisInputError(
          operation,
          undefined,
          projectInputIssues(parsed.error.issues, input),
        ),
      );
};

const schemaCache = new WeakMap<z.ZodType, Readonly<Record<string, unknown>>>();

const unknownArgumentIssues = (
  schema: z.ZodType,
  input: unknown,
): readonly AnalysisInputIssue[] => {
  let jsonSchema = schemaCache.get(schema);
  if (jsonSchema === undefined) {
    const converter = schema["~standard"].jsonSchema?.input;
    if (converter === undefined)
      throw new TypeError(
        "Tool input schema does not expose Standard JSON Schema",
      );
    jsonSchema = closeObjectSchemas(converter({ target: "draft-2020-12" }));
    schemaCache.set(schema, jsonSchema);
  }
  return scanUnknownArguments(input, jsonSchema, jsonSchema, []);
};

const scanUnknownArguments = (
  value: unknown,
  schema: Readonly<Record<string, unknown>>,
  root: Readonly<Record<string, unknown>>,
  path: readonly (string | number)[],
): AnalysisInputIssue[] => {
  const resolved = resolveSchema(schema, root);
  if (Array.isArray(value)) {
    const items = objectValue(resolved.items);
    return items === undefined
      ? []
      : value.flatMap((item, index) =>
          scanUnknownArguments(item, items, root, [...path, index]),
        );
  }
  if (!isObject(value)) return [];
  const variants = schemaVariants(resolved, root);
  const properties = Object.fromEntries(
    variants.flatMap((variant) =>
      Object.entries(objectValue(variant.properties) ?? {}),
    ),
  );
  const closed =
    variants.length > 0 &&
    variants.every(
      (variant) =>
        variant.additionalProperties !== true &&
        !isObject(variant.additionalProperties),
    );
  const issues: AnalysisInputIssue[] = [];
  for (const [key, child] of Object.entries(value)) {
    const propertySchema = objectValue(properties[key]);
    if (propertySchema === undefined) {
      if (closed)
        issues.push({ path: [...path, key], reason: "unknown_argument" });
      continue;
    }
    issues.push(
      ...scanUnknownArguments(child, propertySchema, root, [...path, key]),
    );
  }
  return issues;
};

const schemaVariants = (
  schema: Readonly<Record<string, unknown>>,
  root: Readonly<Record<string, unknown>>,
): readonly Readonly<Record<string, unknown>>[] => {
  const resolved = resolveSchema(schema, root);
  const variants = [resolved.oneOf, resolved.anyOf, resolved.allOf]
    .flatMap((value) => (Array.isArray(value) ? value : []))
    .flatMap((value) => {
      const object = objectValue(value);
      return object === undefined ? [] : schemaVariants(object, root);
    });
  if (variants.length > 0) return variants;
  return resolved.type === "object" || isObject(resolved.properties)
    ? [resolved]
    : [];
};

const resolveSchema = (
  schema: Readonly<Record<string, unknown>>,
  root: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> => {
  const reference = schema.$ref;
  if (typeof reference !== "string" || !reference.startsWith("#/$defs/"))
    return schema;
  const definition = objectValue(objectValue(root.$defs)?.[reference.slice(8)]);
  return definition === undefined ? schema : definition;
};

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const objectValue = (
  value: unknown,
): Readonly<Record<string, unknown>> | undefined =>
  isObject(value) ? value : undefined;
