import { z } from "zod";

import {
  browserScenarioDiffSchema,
  compareBrowserScenarios,
  compareBrowserScenariosInputSchema,
  type BrowserScenarioDiff,
  type CompareBrowserScenariosInput,
} from "./browserScenarioDiff.js";
import {
  compareWebCaptures,
  captureSnapshotSchema,
  webCaptureDiffSchema,
  type WebCaptureDiff,
} from "./webCaptureDiff.js";

const maxChangesSchema = z
  .number()
  .int()
  .min(1)
  .max(20_000)
  .default(2_000)
  .describe("Maximum normalized change records to retain.");

/** Top-level MCP shape for exactly one complete passive or scenario pair. */
export const browserCaptureComparisonInputSchema = z.union([
  z.strictObject({
    before: captureSnapshotSchema.describe("Earlier passive web-page capture."),
    after: captureSnapshotSchema.describe("Later passive web-page capture."),
    max_changes: maxChangesSchema,
  }),
  z.strictObject({
    before_scenario:
      compareBrowserScenariosInputSchema.shape.before_scenario.describe(
        "Earlier browser scenario capture.",
      ),
    after_scenario:
      compareBrowserScenariosInputSchema.shape.after_scenario.describe(
        "Later browser scenario capture.",
      ),
    normalization:
      compareBrowserScenariosInputSchema.shape.normalization.describe(
        "Exact-literal normalization policy.",
      ),
    max_changes: maxChangesSchema,
  }),
]);

/** Parsed browser capture comparison input. */
export type BrowserCaptureComparisonInput = z.output<
  typeof browserCaptureComparisonInputSchema
>;

/** Result from passive page or browser scenario comparison. */
export const browserCaptureComparisonSchema = z.union([
  browserScenarioDiffSchema,
  webCaptureDiffSchema,
]);
/** Browser capture comparison result. */
export type BrowserCaptureComparison = BrowserScenarioDiff | WebCaptureDiff;

/** Dispatch a parsed capture comparison to its pure domain comparator. */
export const compareBrowserCaptures = (
  input: BrowserCaptureComparisonInput,
): BrowserCaptureComparison =>
  isScenarioComparison(input)
    ? compareBrowserScenarios(input)
    : compareWebCaptures(input);

const isScenarioComparison = (
  input: BrowserCaptureComparisonInput,
): input is CompareBrowserScenariosInput => "before_scenario" in input;
