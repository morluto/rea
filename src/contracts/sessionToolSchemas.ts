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
import { replayMachineRunInputSchema } from "../domain/replayMachineRun.js";
import { staticRuntimeCorrelationInputSchema } from "../domain/staticRuntimeCorrelation.js";
import { updateUnknownInputSchema } from "../domain/residualUnknown.js";
import {
  openBinaryInputSchema,
  closeBinaryInputSchema,
} from "./sessionLifecycleInputs.js";
import { binarySessionInputSchema } from "./sessionStatusContract.js";

/** Retain the current canonical Evidence bundle as a session resource. */
export const snapshotEvidenceBundleInputSchema = z.strictObject({});

/** Release one session-retained immutable Evidence bundle. */
export const releaseEvidenceBundleInputSchema = z.strictObject({
  bundle_digest: z.string().regex(/^[a-f0-9]{64}$/u),
});

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
  left_evidence_id: z.string().regex(/^ev_[a-f0-9]{64}$/u),
  right_evidence_id: z.string().regex(/^ev_[a-f0-9]{64}$/u),
  trace_spec: processTraceSpecificationSchema.optional(),
  max_capture_age_ms: z.number().int().nonnegative().optional(),
  unknown_registry_approved: z
    .literal(true)
    .optional()
    .describe("Explicit approval to record capture disagreement durably"),
});

/** Residual-unknown list filters. */
export const listUnknownsInputSchema = z.strictObject({
  status: z
    .enum(["open", "investigating", "blocked", "contradicted", "resolved"])
    .optional(),
  severity: z.enum(["low", "medium", "high", "critical"]).optional(),
  domain: z.string().trim().min(1).max(100).optional(),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(500).default(100),
});

/** Exact residual-unknown identity to revalidate. */
export const verifyUnknownResolutionInputSchema = z.strictObject({
  unknown_id: z.string().regex(/^unk_[a-f0-9]{64}$/u),
});

export {
  artifactComparisonInputSchema,
  binarySessionInputSchema,
  bundleComparisonInputSchema,
  callPathInputSchema,
  changedBehaviorInputSchema,
  closeBinaryInputSchema,
  functionComparisonInputSchema,
  jsonValueSchema,
  openBinaryInputSchema,
  processScenarioSchema,
  reconstructionVerificationInputSchema,
  recordUnknownInputSchema,
  replayMachineRunInputSchema,
  staticRuntimeCorrelationInputSchema,
  updateUnknownInputSchema,
};
