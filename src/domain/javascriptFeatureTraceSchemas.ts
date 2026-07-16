import { z } from "zod";

import { evidenceSchema, providerSchema } from "./evidence.js";
import { javascriptApplicationGraphSchema } from "./javascriptApplicationGraph.js";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const evidenceIdSchema = z.string().regex(/^ev_[a-f0-9]{64}$/u);
const nodeIdSchema = z.string().regex(/^jag_node_[a-f0-9]{64}$/u);
const edgeIdSchema = z.string().regex(/^jag_edge_[a-f0-9]{64}$/u);
const boundedTextSchema = z.string().min(1).max(4_096);

/** Literal starting point for one bounded application trace. */
const applicationFeatureSeedSchema = z.strictObject({
  kind: z.enum([
    "node-id",
    "route",
    "string",
    "api",
    "channel",
    "module",
    "native-export",
  ]),
  value: boundedTextSchema,
  match: z.enum(["exact", "contains"]).nullable().default(null),
  case_sensitive: z.boolean().default(false),
});

const featureTraceLimitsSchema = z.strictObject({
  max_seed_matches: z.number().int().min(1).max(1_000).default(25),
  max_depth: z.number().int().min(0).max(64).default(12),
  max_nodes: z.number().int().min(1).max(50_000).default(2_000),
  max_edges: z.number().int().min(1).max(100_000).default(4_000),
  max_paths: z.number().int().min(1).max(1_000).default(100),
});

/** Evidence-backed application graph and explicit trace bounds. */
export const traceApplicationFeatureInputSchema = z
  .strictObject({
    application: evidenceSchema,
    native_observations: z.array(evidenceSchema).max(64).default([]),
    seed: applicationFeatureSeedSchema,
    direction: z.enum(["outgoing", "incoming", "both"]).default("both"),
    limits: featureTraceLimitsSchema.default({
      max_seed_matches: 25,
      max_depth: 12,
      max_nodes: 2_000,
      max_edges: 4_000,
      max_paths: 100,
    }),
  })
  .superRefine((input, context) => {
    const ids = input.native_observations.map(({ evidence_id: id }) => id);
    if (new Set(ids).size !== ids.length)
      context.addIssue({
        code: "custom",
        path: ["native_observations"],
        message: "Native observations must be unique",
      });
  });

const seedMatchSchema = z.strictObject({
  node_id: nodeIdSchema,
  kind: z.string().min(1).max(128),
  basis: z.enum(["node-id", "label", "identity", "property"]),
  field: z.string().min(1).max(256),
});

const tracePathSchema = z.strictObject({
  path_id: z.string().regex(/^jatp_[a-f0-9]{64}$/u),
  start_node_id: nodeIdSchema,
  end_node_id: nodeIdSchema,
  end_kind: z.string().min(1).max(128),
  node_ids: z.array(nodeIdSchema).min(1).max(65),
  edge_ids: z.array(edgeIdSchema).max(64),
  authorities: z.array(z.string().min(1).max(128)).max(16),
  contains_inference: z.boolean(),
});

const nativeHandoffSchema = z.strictObject({
  native_node_id: nodeIdSchema,
  artifact_sha256: digestSchema,
  artifact_path: z.string().min(1).max(4_096).nullable(),
  export_node_ids: z.array(nodeIdSchema).max(1_000),
  requested_exports: z.array(boundedTextSchema).max(1_000),
  status: z.enum(["evidence-linked", "requires-provider-analysis"]),
  providers: z.array(providerSchema).max(64),
  evidence_ids: z.array(evidenceIdSchema).max(64),
  recommended_tools: z
    .array(
      z.enum([
        "open_binary",
        "binary_overview",
        "search_procedures",
        "analyze_function",
        "xrefs",
      ]),
    )
    .max(5),
});

/** Evidence-preserving bounded subgraph and native-analysis frontiers. */
export const applicationFeatureTraceResultSchema = z.strictObject({
  schema_version: z.literal(1),
  trace_id: z.string().regex(/^jatr_[a-f0-9]{64}$/u),
  source_evidence_id: evidenceIdSchema,
  source_graph_id: z.string().regex(/^jag_[a-f0-9]{64}$/u),
  seed: applicationFeatureSeedSchema,
  direction: z.enum(["outgoing", "incoming", "both"]),
  seed_matches: z.array(seedMatchSchema).max(1_000),
  graph: javascriptApplicationGraphSchema.nullable(),
  paths: z.array(tracePathSchema).max(1_000),
  native_handoffs: z.array(nativeHandoffSchema).max(10_000),
  summary: z.strictObject({
    matched_seeds: z.number().int().min(0),
    traced_nodes: z.number().int().min(0),
    traced_edges: z.number().int().min(0),
    terminal_paths: z.number().int().min(0),
    native_handoffs: z.number().int().min(0),
    observed_facts: z.number().int().min(0),
    inferred_facts: z.number().int().min(0),
    unknown_facts: z.number().int().min(0),
    unavailable_facts: z.number().int().min(0),
  }),
  coverage: z.strictObject({
    status: z.enum([
      "complete-within-source",
      "partial",
      "truncated",
      "no-match",
    ]),
    source_graph_status: z.enum([
      "complete",
      "partial",
      "unknown",
      "unavailable",
    ]),
    scanned_nodes: z.number().int().min(0),
    total_seed_matches: z.number().int().min(0),
    omitted_seed_matches: z.number().int().min(0),
    omitted_nodes: z.number().int().min(0),
    omitted_edges: z.number().int().min(0),
    omitted_paths: z.number().int().min(0),
    frontier_node_ids: z.array(nodeIdSchema).max(50_000),
  }),
  evidence_links: z.array(evidenceIdSchema).min(1).max(65),
  limitations: z.array(boundedTextSchema).max(1_000),
});

export type TraceApplicationFeatureInput = z.infer<
  typeof traceApplicationFeatureInputSchema
>;
export type ApplicationFeatureSeed = z.infer<
  typeof applicationFeatureSeedSchema
>;
export type ApplicationFeatureTraceResult = z.infer<
  typeof applicationFeatureTraceResultSchema
>;
