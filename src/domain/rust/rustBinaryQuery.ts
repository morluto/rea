import { z } from "zod";
import {
  checkInspectRustBinaryOptions,
  inspectRustBinaryInputObjectSchema,
  rustInferredCrateSchema,
  rustInferredCrateSourceKindSchema,
  rustPackageSchema,
  rustPackageFeaturesSchema,
  rustAuditableMetadataSchema,
} from "./rustBinary.js";

const edgeSchema = rustAuditableMetadataSchema.shape.dependency_edges.element;
const index = z.number().int().nonnegative();
const page = {
  indices: z.array(index).optional(),
  offset: index.default(0),
  limit: z.number().int().positive().default(64),
};
const packages = z.strictObject({
  ...page,
  collection: z.literal("packages"),
  names: z.array(z.string()).optional(),
  versions: z.array(z.string()).optional(),
  fields: z
    .array(rustPackageSchema.keyof())
    .optional()
    .describe(
      "Original index always retained. Default attributes omit dependency vectors; select dependencies explicitly for direct index references.",
    ),
});
const edges = z.strictObject({
  ...page,
  collection: z.literal("edges"),
  from_indices: z.array(index).optional(),
  to_indices: z.array(index).optional(),
  fields: z.array(edgeSchema.keyof()).optional(),
});
const inferredCrates = z.strictObject({
  ...page,
  collection: z.literal("inferred_crates"),
  name: z.string().min(1).optional(),
  names: z.array(z.string()).optional(),
  contains: z.string().min(1).optional(),
  source_kind: rustInferredCrateSourceKindSchema.optional(),
  fields: z.array(rustInferredCrateSchema.keyof()).optional(),
});

/** Filters intersect; empty arrays select none and offsets count matching rows. */
export const rustBinarySelectionSchema = z.discriminatedUnion("collection", [
  packages,
  edges,
  inferredCrates,
]);
export const rustBinaryViewRequestSchema = z.discriminatedUnion("collection", [
  packages.extend({ kind: z.literal("rust") }),
  edges.extend({ kind: z.literal("rust") }),
  inferredCrates.extend({ kind: z.literal("rust") }),
]);
export const rustBinaryViewPageSchema = z.discriminatedUnion("collection", [
  z.strictObject({
    collection: z.literal("packages"),
    rows: z.array(
      rustPackageSchema.partial().extend({
        features: rustPackageFeaturesSchema.optional(),
        index,
      }),
    ),
  }),
  z.strictObject({
    collection: z.literal("edges"),
    rows: z.array(edgeSchema.partial().extend({ index })),
  }),
  z.strictObject({
    collection: z.literal("inferred_crates"),
    rows: z.array(rustInferredCrateSchema.partial().extend({ index })),
  }),
]);

/** Delivery choices never enter the file-reader port or change original Evidence identity. */
export const inspectRustBinaryRequestSchema = inspectRustBinaryInputObjectSchema
  .extend({
    detail: z.enum(["complete", "summary"]).optional(),
    view: rustBinarySelectionSchema.optional(),
  })
  .superRefine((value, context) => {
    checkInspectRustBinaryOptions(value, context);
    if (value.view !== undefined && value.detail === "complete")
      context.addIssue({
        code: "custom",
        path: ["view"],
        message:
          "view selects compact delivery; omit view for complete Evidence",
      });
    if (
      value.view?.collection === "inferred_crates" &&
      value.include_inferred_crates !== true
    )
      context.addIssue({
        code: "custom",
        path: ["view", "collection"],
        message:
          "inferred_crates view requires include_inferred_crates to be true.",
      });
  });
