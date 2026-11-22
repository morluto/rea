import { z } from "zod";
import {
  androidJniViewItemsSchema,
  androidJniViewRequestSchema,
} from "../../android/androidJniQuery.js";
import {
  androidComponentSummaryViewRequestSchema,
  androidComponentsViewRequestSchema,
  androidManifestViewRequestSchema,
} from "../../android/androidPackageQuery.js";
import {
  summaryViewResultBase,
  viewResultBaseFields,
} from "../analysisViewBase.js";
import { androidJniSummarySchema } from "../androidJniView.js";
import {
  androidComponentSummarySchema,
  androidComponentViewContextSchema,
  androidComponentViewRowSchema,
  androidManifestViewItemSchema,
  androidPackageSummarySchema,
} from "../androidPackageView.js";
import {
  androidClassSummarySchema,
  androidMethodSummarySchema,
} from "../androidSymbolView.js";

/** Exact package declarations with retained decoded manifest text. */
export const androidPackageSummaryViewResultSchema = z.strictObject({
  ...summaryViewResultBase,
  parent_operation: z.literal("inspect_android_package"),
  summary: androidPackageSummarySchema,
});

export const androidJniSummaryViewResultSchema = z.strictObject({
  ...summaryViewResultBase,
  parent_operation: z.literal("inspect_android_jni_bindings"),
  summary: androidJniSummarySchema,
});

export const androidJniPageViewResultSchema = z.strictObject({
  ...viewResultBaseFields,
  kind: z.literal("android-jni"),
  parent_operation: z.literal("inspect_android_jni_bindings"),
  view: androidJniViewRequestSchema,
  items: androidJniViewItemsSchema,
  source: androidJniSummarySchema.pick({
    native_inventory: true,
    library_inventory: true,
    selection: true,
  }),
});

/** Exact class facts with complete raw protocol Evidence retained separately. */
export const androidClassSummaryViewResultSchema = z.strictObject({
  ...summaryViewResultBase,
  parent_operation: z.literal("inspect_android_class"),
  summary: androidClassSummarySchema,
});

/** Exact selected method body, source coverage and optional mapping facts. */
export const androidMethodSummaryViewResultSchema = z.strictObject({
  ...summaryViewResultBase,
  parent_operation: z.literal("inspect_android_method"),
  summary: androidMethodSummarySchema,
});

/** One page of the retained manifest text. */
export const androidManifestViewResultSchema = z.strictObject({
  ...viewResultBaseFields,
  kind: z.literal("android"),
  facet: z.literal("manifest"),
  view: androidManifestViewRequestSchema,
  item: androidManifestViewItemSchema,
  parent_operation: z.literal("inspect_android_package"),
});

export const androidComponentsViewResultSchema = z.strictObject({
  ...viewResultBaseFields,
  ...androidComponentViewContextSchema.shape,
  kind: z.literal("android"),
  facet: z.literal("components"),
  view: androidComponentsViewRequestSchema,
  items: z.array(androidComponentViewRowSchema),
  byte_limited: z.boolean(),
  parent_operation: z.literal("inspect_android_package"),
});

export const androidComponentSummaryViewResultSchema = z.strictObject({
  ...viewResultBaseFields,
  ...androidComponentViewContextSchema.shape,
  kind: z.literal("android"),
  facet: z.literal("component-summary"),
  view: androidComponentSummaryViewRequestSchema,
  summary: androidComponentSummarySchema,
  parent_operation: z.literal("inspect_android_package"),
});
