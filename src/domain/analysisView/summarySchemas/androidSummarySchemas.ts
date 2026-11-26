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
import { androidMethodSummarySchema } from "../androidSymbolView.js";
import {
  androidClassSummarySchema,
  androidClassViewItemsSchema,
} from "../androidClassView.js";
import { androidClassViewRequestSchema } from "../../android/androidClassQuery.js";
import {
  androidReferencesViewRequestSchema,
  androidReferenceTopClassesViewRequestSchema,
} from "../../android/androidReferencesQuery.js";
import {
  androidReferenceRowSchema,
  androidReferencesSummarySchema,
  androidReferencesTargetSchema,
  androidReferenceTopClassRowSchema,
} from "../androidReferencesView.js";

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

/** Class identity and counts; members page through the android-class view. */
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

/** Counts of one retained trace_android_references result. */
export const androidReferencesSummaryViewResultSchema = z.strictObject({
  ...summaryViewResultBase,
  parent_operation: z.literal("trace_android_references"),
  summary: androidReferencesSummarySchema,
});

const referencesPageBase = {
  ...viewResultBaseFields,
  kind: z.literal("android-references"),
  parent_operation: z.literal("trace_android_references"),
  target: androidReferencesTargetSchema,
};

/** One page of retained using nodes, or of their distinct top classes. */
export const androidReferencesPageViewResultSchema = z.discriminatedUnion(
  "facet",
  [
    z.strictObject({
      ...referencesPageBase,
      facet: z.literal("references"),
      view: androidReferencesViewRequestSchema,
      items: z.array(androidReferenceRowSchema),
      byte_limited: z.boolean(),
    }),
    z.strictObject({
      ...referencesPageBase,
      facet: z.literal("top-classes"),
      view: androidReferenceTopClassesViewRequestSchema,
      items: z.array(androidReferenceTopClassRowSchema),
      byte_limited: z.boolean(),
    }),
  ],
);

/** One page of a retained class inspection's methods, fields, inner classes or mapping symbols. */
export const androidClassPageViewResultSchema = z.strictObject({
  ...viewResultBaseFields,
  kind: z.literal("android-class"),
  parent_operation: z.literal("inspect_android_class"),
  view: androidClassViewRequestSchema,
  class_name: z.string(),
  items: androidClassViewItemsSchema,
  byte_limited: z.boolean(),
});
