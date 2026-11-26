import { z } from "zod";

const names = (description: string) =>
  z.array(z.string().min(1)).min(1).optional().describe(description);

/** One page of the decoded string rows, across the decoded tables. */
export const apktoolStringsViewRequestSchema = z.strictObject({
  kind: z.literal("android-resources"),
  facet: z.literal("strings"),
  offset: z.int().nonnegative().default(0),
  limit: z.int().positive().default(64),
  locales: z
    .array(z.string().min(1).nullable())
    .min(1)
    .optional()
    .describe(
      "Decoded tables to read: null for the default table, or a locale exactly as string_tables[].locale reports it. Omit for every decoded table.",
    ),
  names: names("Exact string resource names"),
  name_prefixes: names("String resource name prefixes, matched exactly"),
});

/** Exact decoded AndroidManifest.xml text; positions count UTF-16 code units. */
export const apktoolManifestViewRequestSchema = z.strictObject({
  kind: z.literal("android-resources"),
  facet: z.literal("manifest"),
  offset: z.int().nonnegative().default(0),
  limit: z.int().positive().max(65_536).default(16_384),
});

export const apktoolResourcesViewRequestSchema = z.discriminatedUnion("facet", [
  apktoolStringsViewRequestSchema,
  apktoolManifestViewRequestSchema,
]);
