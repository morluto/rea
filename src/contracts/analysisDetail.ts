import { z } from "zod";

import { analysisViewResultSchema } from "../domain/analysisView/analysisView.js";
import { evidenceResultOf } from "./toolOutputSchemaPrimitives.js";

/** Caller-selected delivery of completed analysis Evidence that supports retained views. */
export const analysisDetailSchema = z
  .enum(["complete", "summary"])
  .default("complete")
  .describe(
    "complete returns the complete analysis Evidence inline. summary retains that complete Evidence in this session and returns its inspect_analysis_view summary; inspect pages, items or facets through normalized_result.parent_evidence_id.",
  );

/** Complete analysis Evidence, or the summary view of its retained record. */
export const analysisDetailOutputSchemaOf = <Schema extends z.ZodType>(
  analysis: Schema,
) => evidenceResultOf(z.union([analysis, analysisViewResultSchema]));
