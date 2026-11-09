import { z } from "zod";
import {
  ANDROID_KOTLIN_METADATA_INLINE_ROWS,
  androidKotlinClassSchema,
  androidKotlinMetadataKindSchema,
} from "./androidKotlinMetadata.js";
import { validateAndroidPackageDelivery } from "./androidPackageQuery.js";

/**
 * Pages reference original parent row indices, so a page can be re-read from the
 * retained Evidence without reopening the APK or rerunning the DEX reader.
 */
export const androidKotlinViewRequestSchema = z.strictObject({
  kind: z.literal("android-kotlin"),
  collection: z.literal("classes"),
  offset: z.int().nonnegative().default(0),
  limit: z.int().positive().default(64),
  indices: z.array(z.int().nonnegative()).optional(),
  class_names: z
    .array(z.string())
    .optional()
    .describe("Exact fully qualified class names; [] matches none"),
  package_prefix: z
    .string()
    .min(1)
    .optional()
    .describe("Literal class-name prefix"),
  kinds: z
    .array(androidKotlinMetadataKindSchema)
    .optional()
    .describe("Declaration kinds; [] matches none"),
  fields: z.array(androidKotlinClassSchema.keyof()).optional(),
});

/** Selected fields only; `row_index` is the original position in the retained inventory. */
export const androidKotlinViewItemsSchema = z.array(
  androidKotlinClassSchema
    .partial()
    .extend({ row_index: z.int().nonnegative() }),
);

/** CLI and MCP share one delivery admission before analysis starts. */
export const androidKotlinDeliverySchema = z
  .strictObject({
    detail: z.enum(["complete", "summary"]).default("complete"),
    view: androidKotlinViewRequestSchema.optional(),
  })
  .superRefine(validateAndroidPackageDelivery);

/** Complete delivery inlines the listing; only a retained summary may hold more. */
export const validateAndroidKotlinListing = (
  value: {
    readonly detail?: "complete" | "summary" | undefined;
    readonly limit?: number | undefined;
  },
  context: z.RefinementCtx,
): void => {
  if (
    value.detail !== "summary" &&
    value.limit !== undefined &&
    value.limit > ANDROID_KOTLIN_METADATA_INLINE_ROWS
  )
    context.addIssue({
      code: "custom",
      path: ["limit"],
      message: `Complete detail lists at most ${ANDROID_KOTLIN_METADATA_INLINE_ROWS} classes inline; select detail summary to retain a larger inventory and page it with a view.`,
    });
};
