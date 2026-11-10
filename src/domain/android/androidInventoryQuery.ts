import { z } from "zod";
import { androidReferenceSchema } from "./androidReferenceSchemas.js";
import { validateAndroidPackageDelivery } from "./androidPackageQuery.js";

const page = {
  offset: z.int().nonnegative().default(0),
  limit: z.int().positive().default(64),
  indices: z.array(z.int().nonnegative()).optional(),
};

/**
 * Pages reference original parent row indices, so a page can be read again from
 * retained Evidence without reopening the APK or rerunning the decompiler.
 */
export const androidClassesViewRequestSchema = z.discriminatedUnion(
  "collection",
  [
    z.strictObject({
      kind: z.literal("android-classes"),
      collection: z.literal("matches"),
      ...page,
      class_names: z
        .array(z.string())
        .optional()
        .describe("Exact class-name rows; [] matches none"),
      package_prefix: z
        .string()
        .min(1)
        .optional()
        .describe("Literal class-name prefix"),
    }),
    z.strictObject({
      kind: z.literal("android-classes"),
      collection: z.literal("duplicate_names"),
      ...page,
      class_names: z
        .array(z.string())
        .optional()
        .describe("Exact repeated class names; [] matches none"),
    }),
  ],
);

/** `row_index` is the original position in the retained collection. */
export const androidClassesViewItemsSchema = z.union([
  z.array(
    z.strictObject({ name: z.string(), row_index: z.int().nonnegative() }),
  ),
  z.array(
    z.strictObject({
      name: z.string(),
      occurrences: z.int().min(2),
      row_index: z.int().nonnegative(),
    }),
  ),
]);

/** Using nodes of one traced class or method; `fields` limits the projected columns. */
export const androidReferencesViewRequestSchema = z.strictObject({
  kind: z.literal("android-references"),
  collection: z.literal("references"),
  ...page,
  kinds: z
    .array(z.string())
    .optional()
    .describe("Exact provider node kinds; [] matches none"),
  containing_classes: z
    .array(z.string())
    .optional()
    .describe("Exact containing class names; [] matches none"),
  top_classes: z
    .array(z.string())
    .optional()
    .describe("Exact top-level class names; [] matches none"),
  fields: z.array(androidReferenceSchema.keyof()).optional(),
});

/** Selected fields only; `row_index` is the original position in the retained inventory. */
export const androidReferencesViewItemsSchema = z.array(
  androidReferenceSchema.partial().extend({ row_index: z.int().nonnegative() }),
);

/** CLI and MCP share one delivery admission before analysis starts. */
export const androidClassesDeliverySchema = z
  .strictObject({
    detail: z.enum(["complete", "summary"]).default("complete"),
    view: androidClassesViewRequestSchema.optional(),
  })
  .superRefine(validateAndroidPackageDelivery);

/** CLI and MCP share one delivery admission before analysis starts. */
export const androidReferencesDeliverySchema = z
  .strictObject({
    detail: z.enum(["complete", "summary"]).default("complete"),
    view: androidReferencesViewRequestSchema.optional(),
  })
  .superRefine(validateAndroidPackageDelivery);
