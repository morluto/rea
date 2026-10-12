import { z } from "zod";

import { evidenceResultOf } from "./toolOutputSchemaPrimitives.js";

/** Caller-selected delivery of completed analysis Evidence that supports retained views. */
export const analysisDetailSchema = z
  .enum(["complete", "summary"])
  .default("complete")
  .describe(
    "complete returns the complete analysis Evidence inline. summary retains that complete Evidence in this session and returns its inspect_analysis_view summary; inspect pages, items or facets through normalized_result.parent_evidence_id.",
  );

/**
 * Complete analysis Evidence, or that operation's summary view of its retained
 * record. Callers pass the summary variant the handler actually returns so the
 * advertised output does not accept other view kinds.
 */
export const analysisDetailOutputSchemaOf = <
  Analysis extends z.ZodType,
  Summary extends z.ZodType,
>(
  analysis: Analysis,
  summary: Summary,
) => evidenceResultOf(z.union([analysis, summary]));
