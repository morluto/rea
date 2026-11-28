import { z } from "zod";
import { absoluteLocalPathStringSchema } from "../localPath.js";
import {
  parameterBudgetLimit,
  parameterBudgetSchema,
  type ParameterBudget,
} from "../parameterBudget.js";
import type { AnalysisParameterLimit } from "../analysisSettings.js";
import {
  EVTX_ARCHIVE_MAX_FILE_BYTES,
  EVTX_ARCHIVE_MAX_RECORDS,
} from "./evtxArchive.js";

/** Per-call read and record budgets shared by the input schema and refusal limits. */
export const EVTX_ARCHIVE_BUDGETS = {
  max_file_bytes: {
    minimum: 1,
    maximum: EVTX_ARCHIVE_MAX_FILE_BYTES,
    default_value: EVTX_ARCHIVE_MAX_FILE_BYTES,
    unit: "bytes",
  },
  max_records: {
    minimum: 1,
    maximum: EVTX_ARCHIVE_MAX_RECORDS,
    default_value: EVTX_ARCHIVE_MAX_RECORDS,
    unit: "count",
  },
} as const satisfies Record<string, ParameterBudget>;
export type EvtxArchiveBudget = keyof typeof EVTX_ARCHIVE_BUDGETS;

/** The per-call control that stopped an event-log inventory. */
export const evtxArchiveBudgetLimit = (
  parameter: EvtxArchiveBudget,
  effectiveValue: number,
): AnalysisParameterLimit =>
  parameterBudgetLimit(
    parameter,
    EVTX_ARCHIVE_BUDGETS[parameter],
    effectiveValue,
  );

export const inspectEvtxArchiveInputSchema = z.strictObject({
  path: absoluteLocalPathStringSchema.describe(
    "Absolute path to one local Windows Event Log (.evtx) file",
  ),
  format: z.enum(["evtx"]).default("evtx"),
  max_file_bytes: parameterBudgetSchema(
    EVTX_ARCHIVE_BUDGETS.max_file_bytes,
  ).describe("Maximum bytes read from the log file (up to 64 MiB)"),
  max_records: parameterBudgetSchema(EVTX_ARCHIVE_BUDGETS.max_records).describe(
    "Maximum event records decoded (up to 20000); a larger log reports the limit instead of listing every event",
  ),
});
export type InspectEvtxArchiveInput = z.output<
  typeof inspectEvtxArchiveInputSchema
>;
