import { z } from "zod";

import { integrityContradictionSchema } from "../../artifactGraph.js";
import {
  summaryViewResultBase,
  viewResultBaseFields,
} from "../analysisViewBase.js";
import {
  artifactExtractionSummarySchema,
  artifactExtractionViewRequestSchema,
  extractedArtifactRowSchema,
} from "../artifactExtractionView.js";

const parent_operation = z.literal("extract_artifact");

/** Identity, verification and counts of one retained extraction. */
export const artifactExtractionSummaryViewResultSchema = z.strictObject({
  ...summaryViewResultBase,
  parent_operation,
  summary: artifactExtractionSummarySchema,
});

/** One page of written files, integrity contradictions or residual paths. */
export const artifactExtractionPageViewResultSchema = z.strictObject({
  ...viewResultBaseFields,
  kind: z.literal("artifact-extraction"),
  parent_operation,
  view: artifactExtractionViewRequestSchema,
  output_root: z.string().min(1),
  items: z.array(
    z.union([
      extractedArtifactRowSchema,
      integrityContradictionSchema,
      z.string(),
    ]),
  ),
  byte_limited: z.boolean(),
});
