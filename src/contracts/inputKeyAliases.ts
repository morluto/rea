import { z } from "zod";
import { withAdvertisedJsonSchema } from "./toolSchemaMetadata.js";

/** Compatibility spellings accepted by named tool contracts. */
const INPUT_KEY_ALIASES = [
  ["address", "procedure"],
  ["query", "pattern"],
] as const;

/** Compatibility keys apply only when they do not collide with named inputs. */
export const inputKeyAliasesFor = (
  schema: z.ZodObject,
): Readonly<Record<string, string>> =>
  Object.fromEntries(
    INPUT_KEY_ALIASES.filter(
      ([alias, canonical]) =>
        Object.hasOwn(schema.shape, canonical) &&
        !Object.hasOwn(schema.shape, alias),
    ),
  );

/** Normalize a parsed compatibility request without mutating caller values. */
export const canonicalInputKeys = (
  value: Readonly<Record<string, unknown>>,
  aliases: Readonly<Record<string, string>>,
): Readonly<Record<string, unknown>> => {
  const normalized = { ...value };
  for (const [alias, canonical] of Object.entries(aliases)) {
    if (!Object.hasOwn(value, alias) || Object.hasOwn(value, canonical))
      continue;
    normalized[canonical] = value[alias];
    delete normalized[alias];
  }
  return normalized;
};

/**
 * One contract owns both accepted input spellings and canonical parsed output.
 * Strict alternatives reject a request containing both spellings. JSON Schema
 * input projection advertises one strict object that accepts exactly those
 * alternatives to validating MCP hosts.
 */
export const compatibleToolInputSchema = <Schema extends z.ZodObject>(
  schema: Schema,
): z.ZodType<z.output<Schema>, z.input<Schema>> => {
  // With exactOptionalPropertyTypes, TypeScript cannot relate a generic object
  // schema, or its preprocess wrapper, to the schema's own inferred input and
  // output. Both parse Schema's accepted spellings into Schema's output.
  const typed = (value: unknown) =>
    value as z.ZodType<z.output<Schema>, z.input<Schema>>;
  const aliases = inputKeyAliasesFor(schema);
  if (Object.keys(aliases).length === 0) return typed(schema);
  let shapes: z.ZodRawShape[] = [schema.shape];
  for (const [alias, canonical] of Object.entries(aliases))
    shapes = shapes.flatMap((shape) => {
      const alternative = { ...shape };
      alternative[alias] = alternative[canonical]!;
      delete alternative[canonical];
      return [shape, alternative];
    });
  const accepted = z.union(shapes.map((shape) => z.strictObject(shape)));
  const canonical = typed(
    z.preprocess((value, context) => {
      if (typeof value !== "object" || value === null || Array.isArray(value))
        return value;
      const input = Object.fromEntries(Object.entries(value));
      for (const [alias, key] of Object.entries(aliases)) {
        if (Object.hasOwn(input, alias) && Object.hasOwn(input, key)) {
          context.addIssue({
            code: "custom",
            message: `Supply either ${key} or ${alias}, not both`,
          });
          return z.NEVER;
        }
      }
      return canonicalInputKeys(input, aliases);
    }, schema),
  );
  return withAdvertisedJsonSchema(canonical, "input", () => (options) => {
    const { anyOf, ...projected } =
      accepted["~standard"].jsonSchema.input(options);
    const alternatives: unknown[] = Array.isArray(anyOf) ? anyOf : [];
    const required = requiredIn(alternatives[0]).filter((name) =>
      alternatives.every((branch) => requiredIn(branch).includes(name)),
    );
    const invalidSelections = Object.entries(aliases).flatMap(
      ([alias, key]) => {
        const selectorRequired =
          alternatives.length > 0 &&
          alternatives.every(
            (branch) =>
              requiredIn(branch).includes(key) ||
              requiredIn(branch).includes(alias),
          );
        const conflicts: Record<string, unknown>[] = [
          { required: [key, alias] },
        ];
        if (selectorRequired)
          conflicts.push({
            not: { anyOf: [{ required: [key] }, { required: [alias] }] },
          });
        return conflicts;
      },
    );
    // One strict object with these exclusions accepts exactly the alternatives:
    // their properties, the keys every alternative requires, and one spelling
    // per selector. Advertising it flat, rather than leaving the root union to
    // the shared presentation, avoids an input-group sentence per tool; the
    // full catalog has a bounded transport frame. The exclusion is not a
    // prohibited root combinator for hosts that reject root unions.
    return {
      ...projected,
      type: "object",
      properties: Object.fromEntries(
        alternatives.flatMap((branch) =>
          Object.entries(propertiesIn(branch)).map(([name, property]) => [
            name,
            describeAliasByCanonical(
              property,
              Object.hasOwn(aliases, name) ? aliases[name] : undefined,
            ),
          ]),
        ),
      ),
      ...(required.length > 0 ? { required } : {}),
      additionalProperties: false,
      not: { anyOf: invalidSelections },
      ...(schema.description === undefined
        ? {}
        : { description: schema.description }),
    };
  });
};

const requiredIn = (branch: unknown): readonly unknown[] =>
  typeof branch === "object" &&
  branch !== null &&
  "required" in branch &&
  Array.isArray(branch.required)
    ? branch.required
    : [];

const propertiesIn = (branch: unknown): object =>
  typeof branch === "object" &&
  branch !== null &&
  "properties" in branch &&
  typeof branch.properties === "object" &&
  branch.properties !== null
    ? branch.properties
    : {};

/**
 * An alias names its canonical spelling instead of copying the description:
 * every advertised byte counts against the full catalog's bounded transport
 * frame, and an alias left without a description would receive the key-based
 * fallback, whose meaning can differ from the canonical property (`query` on
 * `search_bytes`).
 */
const describeAliasByCanonical = (
  property: unknown,
  canonical: string | undefined,
): unknown =>
  canonical === undefined || typeof property !== "object" || property === null
    ? property
    : { ...property, description: `Same as ${canonical}.` };
