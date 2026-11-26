import { z } from "zod";

const names = (description: string) =>
  z.array(z.string().min(1)).min(1).optional().describe(description);

/** Fields of one reference row that a page may select. */
export const androidReferenceFieldSchema = z.enum([
  "kind",
  "name",
  "reported_full_name",
  "containing_class",
  "top_class",
  "source_line",
  "dex_offset",
  "source_selector",
  "direct_invokes_exhaustive",
  "direct_invokes",
]);

const filters = {
  kinds: names("Exact using-node kinds, such as class or method"),
  packages: z
    .array(z.string())
    .min(1)
    .optional()
    .describe(
      "Exact packages of the using node's top_class; use an empty string for the unnamed package",
    ),
  top_classes: names("Exact top_class names"),
};

/** One page of the retained using nodes, in the engine's order. */
export const androidReferencesViewRequestSchema = z.strictObject({
  kind: z.literal("android-references"),
  facet: z.literal("references"),
  offset: z.int().nonnegative().default(0),
  limit: z.int().positive().default(64),
  fields: z
    .array(androidReferenceFieldSchema)
    .min(1)
    .optional()
    .describe("Row fields to return beside index; omit for every field"),
  ...filters,
});

/** Distinct top classes of the matching using nodes, sorted by name. */
export const androidReferenceTopClassesViewRequestSchema = z.strictObject({
  kind: z.literal("android-references"),
  facet: z.literal("top-classes"),
  offset: z.int().nonnegative().default(0),
  limit: z.int().positive().default(256),
  ...filters,
});

export const androidReferencesViewSchema = z.discriminatedUnion("facet", [
  androidReferencesViewRequestSchema,
  androidReferenceTopClassesViewRequestSchema,
]);
