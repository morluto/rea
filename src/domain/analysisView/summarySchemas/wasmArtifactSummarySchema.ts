import { z } from "zod";
import { summaryViewResultBase } from "../analysisViewBase.js";
import { wasmSummarySchema } from "../wasmArtifactView.js";

/** Exact summary carrier for WASM inspection's optional delivery contract. */
export const wasmArtifactSummaryViewResultSchema = z.strictObject({
  ...summaryViewResultBase,
  parent_operation: z.literal("inspect_wasm_artifact"),
  summary: wasmSummarySchema,
});
