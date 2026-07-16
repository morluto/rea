import { z } from "zod";

import { evidenceSchema } from "./evidence.js";
import { javascriptApplicationGraphSchema } from "./javascriptApplicationGraph.js";
import { JAVASCRIPT_APPLICATION_NODE_KINDS } from "./javascriptApplicationGraphSchemas.js";

const evidenceIdSchema = z.string().regex(/^ev_[a-f0-9]{64}$/u);
const nodeIdSchema = z.string().regex(/^jag_node_[a-f0-9]{64}$/u);
const boundedTextSchema = z.string().min(1).max(4_096);

const comparisonLimitsSchema = z.strictObject({
  max_comparison_items: z.number().int().min(1).max(50_000).default(20_000),
  max_candidate_nodes: z.number().int().min(1).max(1_000).default(100),
  max_graph_nodes: z.number().int().min(1).max(100_000).default(20_000),
  max_graph_edges: z.number().int().min(1).max(200_000).default(40_000),
});

/** Two authenticated application versions and deterministic output bounds. */
export const compareApplicationVersionsInputSchema = z
  .strictObject({
    left: evidenceSchema,
    right: evidenceSchema,
    left_native_observations: z.array(evidenceSchema).max(64).default([]),
    right_native_observations: z.array(evidenceSchema).max(64).default([]),
    limits: comparisonLimitsSchema.default({
      max_comparison_items: 20_000,
      max_candidate_nodes: 100,
      max_graph_nodes: 20_000,
      max_graph_edges: 40_000,
    }),
    unknown_registry_approved: z.literal(true).optional(),
  })
  .superRefine((input, context) => {
    if (input.left.evidence_id === input.right.evidence_id)
      context.addIssue({
        code: "custom",
        path: ["right"],
        message: "Application version Evidence must be distinct",
      });
    for (const side of [
      "left_native_observations",
      "right_native_observations",
    ] as const) {
      const ids = input[side].map(({ evidence_id: id }) => id);
      if (new Set(ids).size !== ids.length)
        context.addIssue({
          code: "custom",
          path: [side],
          message: "Native observations must be unique on each side",
        });
    }
  });

const applicationVersionMatchBasisSchema = z.enum([
  "exact-node-identity",
  "exact-content-digest",
  "exact-module-source-digest",
  "source-map-identity",
  "structural-fingerprint",
  "semantic-key",
  "none",
]);

const comparisonItemSchema = z.strictObject({
  item_id: z.string().regex(/^javc_item_[a-f0-9]{64}$/u),
  status: z.enum(["unchanged", "added", "removed", "changed", "unknown"]),
  node_kind: z.enum(JAVASCRIPT_APPLICATION_NODE_KINDS),
  left_node_id: nodeIdSchema.nullable(),
  right_node_id: nodeIdSchema.nullable(),
  match: z.strictObject({
    status: z.enum(["matched", "unmatched", "ambiguous"]),
    basis: applicationVersionMatchBasisSchema,
    confidence: z.enum(["exact", "high", "medium", "unknown"]),
    candidate_left_node_ids: z.array(nodeIdSchema).max(1_000),
    candidate_right_node_ids: z.array(nodeIdSchema).max(1_000),
  }),
  dimensions: z
    .array(
      z.enum([
        "content",
        "location",
        "properties",
        "relationships",
        "availability",
        "coverage",
      ]),
    )
    .max(6),
  evidence_links: z.array(evidenceIdSchema).min(2).max(130),
  limitations: z.array(boundedTextSchema).max(100),
});

/** Tiered module/entity matching plus a bounded cross-version change graph. */
export const applicationVersionComparisonResultSchema = z.strictObject({
  schema_version: z.literal(1),
  comparison_id: z.string().regex(/^javc_[a-f0-9]{64}$/u),
  left: z.strictObject({
    evidence_id: evidenceIdSchema,
    graph_id: z.string().regex(/^jag_[a-f0-9]{64}$/u),
    root_artifact_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  }),
  right: z.strictObject({
    evidence_id: evidenceIdSchema,
    graph_id: z.string().regex(/^jag_[a-f0-9]{64}$/u),
    root_artifact_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  }),
  summary: z.strictObject({
    unchanged: z.number().int().min(0),
    added: z.number().int().min(0),
    removed: z.number().int().min(0),
    changed: z.number().int().min(0),
    unknown: z.number().int().min(0),
  }),
  matching: z.strictObject({
    exact_node_identity: z.number().int().min(0),
    exact_content_digest: z.number().int().min(0),
    exact_module_source_digest: z.number().int().min(0),
    source_map_identity: z.number().int().min(0),
    structural_fingerprint: z.number().int().min(0),
    semantic_key: z.number().int().min(0),
    ambiguous: z.number().int().min(0),
    unmatched: z.number().int().min(0),
  }),
  items: z.array(comparisonItemSchema).max(50_000),
  graph: javascriptApplicationGraphSchema,
  coverage: z.strictObject({
    status: z.enum(["complete-within-inputs", "partial", "truncated"]),
    left_graph_status: z.enum([
      "complete",
      "partial",
      "unknown",
      "unavailable",
    ]),
    right_graph_status: z.enum([
      "complete",
      "partial",
      "unknown",
      "unavailable",
    ]),
    omitted_comparison_items: z.number().int().min(0),
    omitted_candidate_references: z.number().int().min(0),
    omitted_graph_nodes: z.number().int().min(0),
    omitted_graph_edges: z.number().int().min(0),
    omitted_graph_observations: z.number().int().min(0),
  }),
  evidence_links: z.array(evidenceIdSchema).min(2).max(130),
  limitations: z.array(boundedTextSchema).max(1_000),
});

export type CompareApplicationVersionsInput = z.infer<
  typeof compareApplicationVersionsInputSchema
>;
export type ApplicationVersionComparisonItem = z.infer<
  typeof comparisonItemSchema
>;
export type ApplicationVersionComparisonResult = z.infer<
  typeof applicationVersionComparisonResultSchema
>;
export type ApplicationVersionMatchBasis = z.infer<
  typeof applicationVersionMatchBasisSchema
>;
