import { z } from "zod";

import { artifactComparisonInputSchema } from "../domain/artifactComparison.js";
import { bundleComparisonInputSchema } from "../domain/bundleComparison.js";
import { callPathInputSchema } from "../domain/callPath.js";
import { changedBehaviorInputSchema } from "../domain/changedBehavior.js";
import { functionComparisonInputSchema } from "../domain/functionComparison.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import { processScenarioSchema } from "../domain/processCapture.js";
import { processTraceSpecificationSchema } from "../domain/processTraceComparison.js";
import { recordUnknownInputSchema } from "../domain/residualUnknown.js";
import { reconstructionVerificationInputSchema } from "../domain/reconstructionVerification.js";
import { staticRuntimeCorrelationInputSchema } from "../domain/staticRuntimeCorrelation.js";
import { evidenceSchema } from "../domain/evidence.js";
import { updateUnknownInputSchema } from "../domain/residualUnknown.js";
import {
  openBinaryInputSchema,
  closeBinaryInputSchema,
} from "./sessionLifecycleInputs.js";
import { binarySessionInputSchema } from "./sessionStatusContract.js";
import { prefixedDigestSchema } from "./../domain/digests.js";

/** Return the current canonical Evidence bundle inline. */
export const getEvidenceBundleInputSchema = z.strictObject({});

/** Optional document selection for volatile navigation context. */
export const navigationContextInputSchema = z.strictObject({
  document: z.string().min(1).optional(),
});

/** Explicit reproducible address context query. */
export const addressContextInputSchema = z.strictObject({
  address: z.string().min(1),
  document: z.string().min(1).optional(),
});

/** Session-owned Evidence bundle import options. */
export const importEvidenceBundleInputSchema = z.strictObject({
  path: z.string().min(1),
});

/** Evidence references for deterministic process comparison. */
export const processComparisonInputSchema = z.strictObject({
  left: evidenceSchema,
  right: evidenceSchema,
  trace_spec: processTraceSpecificationSchema.optional(),
  max_capture_age_ms: z.number().int().nonnegative().optional(),
});

/** Residual-unknown list filters. */
export const listUnknownsInputSchema = z.strictObject({
  status: z
    .enum(["open", "investigating", "blocked", "contradicted", "resolved"])
    .optional(),
  severity: z.enum(["low", "medium", "high", "critical"]).optional(),
  domain: z.string().trim().min(1).optional(),
});

/** Exact residual-unknown identity to revalidate. */
export const verifyUnknownResolutionInputSchema = z.strictObject({
  unknown_id: prefixedDigestSchema("unk"),
});

export {
  artifactComparisonInputSchema,
  binarySessionInputSchema,
  bundleComparisonInputSchema,
  callPathInputSchema,
  changedBehaviorInputSchema,
  closeBinaryInputSchema,
  functionComparisonInputSchema,
  openBinaryInputSchema,
  processScenarioSchema,
  reconstructionVerificationInputSchema,
  recordUnknownInputSchema,
  staticRuntimeCorrelationInputSchema,
  updateUnknownInputSchema,
};
