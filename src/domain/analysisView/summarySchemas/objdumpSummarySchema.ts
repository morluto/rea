import { z } from "zod";
import { commandObservationSchema } from "../../commandObservation.js";
import { artifactSchema, summaryViewResultBase } from "../analysisViewBase.js";
import { commandSummaryContext } from "../commandObservationView.js";

export const objdumpSummaryViewResultSchema = z.strictObject({
  ...summaryViewResultBase,
  ...commandSummaryContext,
  parent_operation: z.literal("inspect_with_objdump"),
  artifact: artifactSchema.nullable(),
  summary: commandObservationSchema,
});
