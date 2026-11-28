import { z } from "zod";

import { knownCoverageStatusSchema } from "../../coverage.js";
import {
  apktoolManifestViewRequestSchema,
  apktoolStringsViewRequestSchema,
} from "../../apktool/apktoolResourcesQuery.js";
import {
  summaryViewResultBase,
  viewResultBaseFields,
} from "../analysisViewBase.js";
import {
  apktoolManifestPageItemSchema,
  apktoolResourcesSummarySchema,
  apktoolStringRowSchema,
  apktoolStringTableSummarySchema,
} from "../apktoolResourcesView.js";

const parent_operation = z.literal("decode_android_resources");

/** Counts and table facts of one retained decode_android_resources result. */
export const apktoolResourcesSummaryViewResultSchema = z.strictObject({
  ...summaryViewResultBase,
  parent_operation,
  summary: apktoolResourcesSummarySchema,
});

/** One page of decoded strings, with the selected tables' own completeness. */
export const apktoolStringsViewResultSchema = z.strictObject({
  ...viewResultBaseFields,
  kind: z.literal("android-resources"),
  facet: z.literal("strings"),
  parent_operation,
  view: apktoolStringsViewRequestSchema,
  tables: z.array(apktoolStringTableSummarySchema),
  decode_coverage: knownCoverageStatusSchema,
  items: z.array(apktoolStringRowSchema),
  byte_limited: z.boolean(),
});

/** One UTF-16 page of the decoded manifest text. */
export const apktoolManifestViewResultSchema = z.strictObject({
  ...viewResultBaseFields,
  kind: z.literal("android-resources"),
  facet: z.literal("manifest"),
  parent_operation,
  view: apktoolManifestViewRequestSchema,
  item: apktoolManifestPageItemSchema,
});

export const apktoolResourcesPageViewResultSchema = z.discriminatedUnion(
  "facet",
  [apktoolStringsViewResultSchema, apktoolManifestViewResultSchema],
);
