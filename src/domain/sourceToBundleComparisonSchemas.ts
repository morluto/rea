import { z } from "zod";

import { evidenceSchema } from "./evidence.js";
import { JAVASCRIPT_APPLICATION_NODE_KINDS } from "./javascriptApplicationGraphSchemas.js";
import { historicalSourceGraphSchema } from "./referenceSourceGraph.js";
import { digestSchema } from "./../domain/digests.js";
import { prefixedDigestSchema } from "./../domain/digests.js";

const evidenceIdSchema = prefixedDigestSchema("ev");
const nodeIdSchema = prefixedDigestSchema("jag_node");
const textSchema = z.string().min(1);

export const SOURCE_TO_BUNDLE_SIGNAL_WEIGHTS = [
  ["exact-source-digest", 100],
  ["source-map-original-path", 70],
  ["current-path-exact", 60],
  ["current-path-suffix", 40],
  ["basename-match", 20],
  ["language-extension", 5],
] as const;

const sourceToBundleSignalKindSchema = z.enum([
  "exact-source-digest",
  "source-map-original-path",
  "current-path-exact",
  "current-path-suffix",
  "basename-match",
  "language-extension",
]);

/** Historical source inventory and authenticated application Evidence. */
export const compareSourceToBundleInputSchema = z.strictObject({
  reference: historicalSourceGraphSchema,
  application: evidenceSchema,
});

const sourceToBundleSignalSchema = z.strictObject({
  kind: sourceToBundleSignalKindSchema,
  weight: z.number().int().min(1).max(100),
  source_value: textSchema,
  current_values: z.array(textSchema).min(1),
});

const sourceToBundleCandidateSchema = z.strictObject({
  current_node_id: nodeIdSchema,
  current_node_kind: z.enum(JAVASCRIPT_APPLICATION_NODE_KINDS),
  score: z.number().int().min(1),
  confidence: z.enum(["exact", "high", "medium", "low"]),
  signals: z.array(sourceToBundleSignalSchema).min(1),
});

const sourceToBundleItemSchema = z.strictObject({
  mapping_id: prefixedDigestSchema("stbc_item"),
  source_path: textSchema,
  source_sha256: digestSchema.nullable(),
  source_language: textSchema.nullable(),
  status: z.enum([
    "unchanged",
    "modified",
    "removed",
    "split",
    "merged",
    "duplicated",
    "unknown",
  ]),
  confidence: z.enum(["exact", "high", "medium", "unknown"]),
  current_node_ids: z.array(nodeIdSchema),
  candidates: z.array(sourceToBundleCandidateSchema),
  limitations: z.array(textSchema),
});

/** Deterministic, evidence-bearing historical-source to shipped-bundle comparison. */
export const sourceToBundleComparisonResultSchema = z.strictObject({
  comparison_id: prefixedDigestSchema("stbc"),
  reference: z.strictObject({
    root_sha256: digestSchema,
    inventory_state: z.enum(["complete", "partial", "unknown"]),
  }),
  application: z.strictObject({
    evidence_id: evidenceIdSchema,
    graph_id: prefixedDigestSchema("jag"),
    root_artifact_sha256: digestSchema,
  }),
  scoring: z.strictObject({
    algorithm: z.literal("rea-source-to-bundle-signals"),
    minimum_candidate_score: z.literal(20),
    weights: z.array(
      z.strictObject({
        signal: sourceToBundleSignalKindSchema,
        weight: z.number().int().min(1).max(100),
      }),
    ),
  }),
  summary: z.strictObject({
    unchanged: z.number().int().min(0),
    modified: z.number().int().min(0),
    removed: z.number().int().min(0),
    split: z.number().int().min(0),
    merged: z.number().int().min(0),
    duplicated: z.number().int().min(0),
    unknown: z.number().int().min(0),
  }),
  items: z.array(sourceToBundleItemSchema),
  unmapped_current_node_ids: z.array(nodeIdSchema),
  coverage: z.strictObject({
    status: z.enum(["complete-within-inputs", "partial"]),
    reference_inventory_state: z.enum(["complete", "partial", "unknown"]),
    application_graph_status: z.enum([
      "complete",
      "partial",
      "unknown",
      "unavailable",
    ]),
    retained_source_files: z.number().int().min(0),
    retained_application_nodes: z.number().int().min(0),
    candidate_evaluations: z.number().int().min(0),
  }),
  evidence_links: z.array(evidenceIdSchema).length(1),
  limitations: z.array(textSchema),
});

export type SourceToBundleComparisonResult = z.infer<
  typeof sourceToBundleComparisonResultSchema
>;
export type SourceToBundleComparisonItem =
  SourceToBundleComparisonResult["items"][number];
export type SourceToBundleCandidate =
  SourceToBundleComparisonItem["candidates"][number];
export type SourceToBundleSignal = SourceToBundleCandidate["signals"][number];
