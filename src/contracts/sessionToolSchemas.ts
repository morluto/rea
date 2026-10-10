import { z } from "zod";
import { isAbsolute } from "node:path";

import { localPathStringSchema } from "../domain/localPath.js";

import { processTraceSpecificationSchema } from "../domain/process/processTraceSpecification.js";
import { evidenceSchema } from "../domain/evidence.js";
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
  path: localPathStringSchema
    .refine(isAbsolute, {
      message:
        "path must be an absolute local filesystem path (for example /tmp/evidence.json or C:\\rea\\evidence.json)",
    })
    .describe(
      "Absolute local filesystem path for the evidence bundle to import; relative paths are rejected.",
    ),
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
