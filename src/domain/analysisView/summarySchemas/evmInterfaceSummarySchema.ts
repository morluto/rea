import { z } from "zod";
import { summaryViewResultBase } from "../analysisViewBase.js";
import { unknownableViewCoverageSchema } from "../analysisViewCoverage.js";
import { evmSummarySchema } from "../evmInterfaceView.js";

/** Exact inferred-interface summary for EVM's caller-selected delivery. */
export const evmInterfaceSummaryViewResultSchema = z.strictObject({
  ...summaryViewResultBase,
  coverage: unknownableViewCoverageSchema,
  parent_operation: z.literal("inspect_evm_interface"),
  summary: evmSummarySchema,
});
