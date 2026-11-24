import { z } from "zod";
import { bundleResourceRootSchema } from "../../apple/bundleResourceRoot.js";
import { summaryViewResultBase } from "../analysisViewBase.js";
import { interfaceBuilderSummarySchema } from "../interfaceBuilderView.js";

/** Decoded documents and graph counts for Interface Builder's selected delivery. */
export const interfaceBuilderSummaryViewResultSchema = z.strictObject({
  ...summaryViewResultBase,
  parent_operation: z.literal("decode_interface_builder"),
  resource_root: bundleResourceRootSchema.optional(),
  summary: interfaceBuilderSummarySchema,
});
