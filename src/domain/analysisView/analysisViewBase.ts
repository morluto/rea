import { z } from "zod";
import { digestSchema, prefixedDigestSchema } from "../digests.js";
import { analysisViewCoverageSchema } from "./analysisViewCoverage.js";
import { summaryViewSchema } from "./analysisViewShape.js";

export const artifactSchema = z.strictObject({
  path: z
    .string()
    .describe(
      "Selected artifact path, or the canonical resource root when resource-only Evidence has no executable subject.",
    ),
  sha256: digestSchema.nullable(),
});

/** Domain-neutral fields shared by every projected view result. */
export const viewResultBaseFields = {
  parent_evidence_id: prefixedDigestSchema("ev"),
  parent_digest: digestSchema,
  view_digest: digestSchema,
  artifact: artifactSchema,
  coverage: analysisViewCoverageSchema,
  limitations: z.array(z.string()),
  unknowns: z.array(z.string()),
} as const;

export const summaryViewResultBase = {
  kind: z.literal("summary"),
  view: summaryViewSchema,
  ...viewResultBaseFields,
} as const;
