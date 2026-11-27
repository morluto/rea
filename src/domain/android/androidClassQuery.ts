import { z } from "zod";

const names = (description: string) =>
  z.array(z.string().min(1)).min(1).optional().describe(description);

const page = (defaultLimit: number) => ({
  kind: z.literal("android-class"),
  offset: z.int().nonnegative().default(0),
  limit: z.int().positive().default(defaultLimit),
});

/** Declared methods in the engine's order, each overload a row. */
export const androidClassMethodsViewRequestSchema = z.strictObject({
  ...page(64),
  facet: z.literal("methods"),
  names: names("Exact method names"),
  name_prefixes: names("Method name prefixes, matched exactly"),
  constructors: z
    .boolean()
    .optional()
    .describe("true selects only constructors; false excludes them"),
});

/** Declared fields with their encoded static final values. */
export const androidClassFieldsViewRequestSchema = z.strictObject({
  ...page(64),
  facet: z.literal("fields"),
  names: names("Exact field names"),
  name_prefixes: names("Field name prefixes, matched exactly"),
  static_values: z
    .boolean()
    .optional()
    .describe(
      "true selects fields with an encoded static value; false selects the rest",
    ),
});

/** Inner class names. */
export const androidClassInnerClassesViewRequestSchema = z.strictObject({
  ...page(256),
  facet: z.literal("inner-classes"),
});

/** Symbols of the caller-selected R8/ProGuard mapping. */
export const androidClassMappingSymbolsViewRequestSchema = z.strictObject({
  ...page(64),
  facet: z.literal("mapping-symbols"),
});

export const androidClassViewRequestSchema = z.discriminatedUnion("facet", [
  androidClassMethodsViewRequestSchema,
  androidClassFieldsViewRequestSchema,
  androidClassInnerClassesViewRequestSchema,
  androidClassMappingSymbolsViewRequestSchema,
]);
