import { z } from "zod";
import {
  browserScenarioCaptureSchema,
  retainedBrowserScenarioCaptureSchema,
} from "./browserScenarioCapture.js";
import { declareEvidenceReferenceAlternative } from "./evidenceInputContract.js";
import { retainedEvidenceReferenceSchema } from "./evidenceReference.js";
import { presentCompleteObservation } from "./schemaAnnotations.js";
import { webPageInspectionSchema } from "./browserObservationSchemas.js";
import { webMcpDiscoverySchema } from "./webMcpDiscovery.js";
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

const comparisonUnionOptions = {
  // Standard Schema clients expose the union message, not its branch errors.
  error: (issue: z.core.$ZodRawIssue) =>
    issue.code === "invalid_union"
      ? z.prettifyError(new z.ZodError(issue.errors.flat()))
      : undefined,
};

/** Mutually exclusive passive and scenario capture comparison inputs. */
export const browserCaptureComparisonInputSchema = z.union(
  [compareWebCapturesInputSchema, compareBrowserScenariosInputSchema],
  comparisonUnionOptions,
);

/**
 * A complete producer observation, or the exact retained Evidence that holds
 * it: the producer's complete record or, for a producer with budgeted
 * delivery, its inspect_analysis_view summary.
 */
const observationOrRetained = <Schema extends z.ZodType>(
  observation: Schema,
  producer: string,
  summarized: boolean,
) =>
  declareEvidenceReferenceAlternative(
    z
      .union([retainedEvidenceReferenceSchema, observation])
      .describe(
        `Complete normalized_result from ${producer}, or {"kind":"retained-evidence","evidence_id":...} naming that retained ${producer} Evidence${summarized ? " or its inspect_analysis_view summary" : ""}.`,
      ),
  );

const captureSnapshotRequestSchema = z.object({
  inspection: observationOrRetained(
    presentCompleteObservation(webPageInspectionSchema),
    "inspect_web_page",
    true,
  ),
  webmcp: observationOrRetained(
    presentCompleteObservation(webMcpDiscoverySchema),
    "discover_webmcp_tools",
    false,
  )
    .nullable()
    .default(null),
});

/**
 * Comparison request: each capture inline, or a retained Evidence reference
 * that the application resolves to the complete capture before comparison.
 */
export const browserCaptureComparisonRequestSchema = z.union(
  [
    z.strictObject({
      before: captureSnapshotRequestSchema,
      after: captureSnapshotRequestSchema,
    }),
    compareBrowserScenariosInputSchema.extend({
      before_scenario: observationOrRetained(
        presentCompleteObservation(retainedBrowserScenarioCaptureSchema),
        "capture_browser_scenario",
        true,
      ),
      after_scenario: observationOrRetained(
        presentCompleteObservation(retainedBrowserScenarioCaptureSchema),
        "capture_browser_scenario",
        true,
      ),
    }),
  ],
  comparisonUnionOptions,
);

/** Parsed comparison request, before retained references are resolved. */
export type BrowserCaptureComparisonRequest = z.output<
  typeof browserCaptureComparisonRequestSchema
>;

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
