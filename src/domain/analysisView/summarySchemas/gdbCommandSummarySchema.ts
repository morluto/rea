import { z } from "zod";
import { artifactSchema, summaryViewResultBase } from "../analysisViewBase.js";
import {
  commandSummaryContext,
  gdbCommandSummarySchema,
} from "../commandObservationView.js";

/** Opt-in command delivery keeps output once and retains the complete parent. */
export const gdbCommandSummaryViewResultSchema = z.strictObject({
  ...summaryViewResultBase,
  ...commandSummaryContext,
  parent_operation: z.literal("gdb_console"),
  artifact: artifactSchema.nullable(),
  summary: gdbCommandSummarySchema,
});
