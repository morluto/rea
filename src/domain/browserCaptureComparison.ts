import { z } from "zod";
import { browserScenarioCaptureSchema } from "./browserScenarioCapture.js";
import { compareBrowserScenarios } from "./browserScenarioDiff.js";
import { compareWebCaptures } from "./webCaptureDiff.js";

import {
  browserScenarioDiffSchema,
  compareBrowserScenariosInputSchema,
  type BrowserScenarioDiff,
} from "./browserScenarioDiffValues.js";
import {
  compareWebCapturesInputSchema,
  webCaptureDiffSchema,
  type WebCaptureDiff,
} from "./webCaptureDiffSchemas.js";

/** Mutually exclusive passive and scenario capture comparison inputs. */
export const browserCaptureComparisonInputSchema = z.union(
  [compareWebCapturesInputSchema, compareBrowserScenariosInputSchema],
  {
    // Standard Schema clients expose the union message, not its branch errors.
    error: (issue) =>
      issue.code === "invalid_union"
        ? z.prettifyError(new z.ZodError(issue.errors.flat()))
        : undefined,
  },
);

/**
 * Whether a capture document is meant as a recorded browser scenario rather
 * than a passive capture. Passive captures own the `inspection` wrapper; a
 * document without it that holds any scenario-owned field is a scenario,
 * even when its manifest is missing, so its own issues are reported.
 */
export const isScenarioCaptureDocument = (document: unknown): boolean =>
  typeof document === "object" &&
  document !== null &&
  !("inspection" in document) &&
  Object.keys(browserScenarioCaptureSchema.shape).some(
    (field) => field in document,
  );

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
  "before_scenario" in input
    ? compareBrowserScenarios(input)
    : compareWebCaptures(input);
