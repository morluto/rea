import { z } from "zod";

import type { ToolContract } from "./toolContracts.js";
import { toolContractMetadata } from "./toolEffects.js";
import { evidenceResultOf } from "./toolOutputSchemas.js";
import {
  electronPageInspectionSchema,
  electronTargetListSchema,
  inspectElectronPageInputSchema,
  listElectronTargetsInputSchema,
} from "../domain/electronObservation.js";
import {
  analyzeJavaScriptApplicationInputSchema,
  javaScriptApplicationAnalysisResultV1Schema,
  javascriptApplicationAnalysisResultSchema,
} from "../domain/javascriptApplicationAnalysis.js";
import { JAVASCRIPT_APPLICATION_NODE_KINDS } from "../domain/javascriptApplicationGraphSchemas.js";
import { applicationCoverageSchema } from "../domain/javascriptApplicationEvidenceSchemas.js";
import {
  javascriptRuntimeReconciliationResultSchema,
  reconcileJavaScriptRuntimeInputSchema,
} from "../domain/javascriptRuntimeReconciliationSchemas.js";
import { JAVASCRIPT_RUNTIME_RECONCILIATION_EXAMPLE } from "./javascriptRuntimeReconciliationExample.js";

const listOutputSchema = evidenceResultOf(electronTargetListSchema);
const inspectionOutputSchema = evidenceResultOf(electronPageInspectionSchema);
/** MCP-only response selection; analysis identity does not depend on projection. */
export const analyzeJavaScriptApplicationToolInputSchema =
  analyzeJavaScriptApplicationInputSchema.extend({
    detail: z
      .enum(["summary", "full"])
      .default("summary")
      .describe(
        "summary returns bounded findings and paged graph resource URIs; full returns the complete graph only when explicitly required",
      ),
  });

/** Bounded default projection for agent-facing JavaScript application analysis. */
const applicationGraphSummarySchema = z.strictObject({
  graph_id: z.string().regex(/^jag_[a-f0-9]{64}$/u),
  node_count: z.number().int().min(0),
  edge_count: z.number().int().min(0),
  roots: z.strictObject({
    items: z.array(z.string().regex(/^jag_node_[a-f0-9]{64}$/u)),
    total: z.number().int().min(0),
    truncated: z.boolean(),
  }),
  node_kinds: z.array(
    z.strictObject({
      kind: z.enum(JAVASCRIPT_APPLICATION_NODE_KINDS),
      count: z.number().int().min(1),
    }),
  ),
  top_findings: z.array(
    z.strictObject({
      node_id: z.string().regex(/^jag_node_[a-f0-9]{64}$/u),
      kind: z.enum(JAVASCRIPT_APPLICATION_NODE_KINDS),
      label: z.string().nullable(),
      authority: z.string(),
      state: z.string(),
      confidence: z.string(),
      location: z.json(),
    }),
  ),
  coverage: applicationCoverageSchema,
  limitations: z.array(z.string()),
  pages: z.strictObject({
    nodes: z.string().startsWith("rea://evidence/"),
    edges: z.string().startsWith("rea://evidence/"),
    page_limit: z.number().int().min(1).max(500),
  }),
});

const semanticGraphSummarySchema = z.strictObject({
  graph_id: z.string().regex(/^jsrg_[a-f0-9]{64}$/u),
  nodes: z.number().int().min(0),
  relations: z.number().int().min(0),
  unknown_frontiers: z.number().int().min(0),
  fingerprints: z.number().int().min(0),
  coverage: z.enum(["complete", "partial", "unknown", "unavailable"]),
  query_tool: z.literal("trace_javascript_semantics"),
});

const summaryFields = {
  unknowns: z.array(z.string().min(1).max(4_096)).max(1_000),
  graph: applicationGraphSummarySchema,
};

/** Bounded default projection for agent-facing JavaScript application analysis. */
export const javascriptApplicationAnalysisSummarySchema = z.discriminatedUnion(
  "schema_version",
  [
    javaScriptApplicationAnalysisResultV1Schema
      .omit({ graph: true })
      .extend(summaryFields),
    javaScriptApplicationAnalysisResultV1Schema.omit({ graph: true }).extend({
      schema_version: z.literal(2),
      ...summaryFields,
      semantic_graph: semanticGraphSummarySchema,
    }),
  ],
);

const applicationOutputSchema = evidenceResultOf(
  z.union([
    javascriptApplicationAnalysisSummarySchema,
    javascriptApplicationAnalysisResultSchema,
  ]),
);
const reconciliationOutputSchema = evidenceResultOf(
  javascriptRuntimeReconciliationResultSchema,
);

const endpoint = "http://127.0.0.1:9223";
const root = "/Applications/Example.app/Contents/Resources";

/** Root-confined Electron file-page discovery and inspection contracts. */
export const ELECTRON_TOOL_CONTRACTS = [
  {
    name: "list_electron_targets",
    ...toolContractMetadata("list_electron_targets"),
    description:
      "List Electron file:// page targets from an approved user-owned loopback CDP endpoint. Every path is canonicalized and must remain contained by an approved filesystem root, including after symlink resolution.",
    kind: "electron-provider",
    inputSchema: listElectronTargetsInputSchema,
    outputSchema: listOutputSchema,
    examples: [
      {
        title: "List approved Electron file pages",
        input: {
          cdp_endpoint: endpoint,
          allowed_file_roots: [root],
          approved: true,
          offset: 0,
          limit: 100,
        },
      },
    ],
  },
  {
    name: "inspect_electron_page",
    ...toolContractMetadata("inspect_electron_page"),
    description:
      "Passively inspect one approved Electron file page through CDP. Returns root-confined frames, DOM structure, resource paths, and scripts without evaluating renderer JavaScript or invoking Electron APIs; script contents require separate approval.",
    kind: "electron-provider",
    inputSchema: inspectElectronPageInputSchema,
    outputSchema: inspectionOutputSchema,
    examples: [
      {
        title: "Inspect an approved Electron page",
        input: {
          cdp_endpoint: endpoint,
          allowed_file_roots: [root],
          target_id: "TARGET_ID_FROM_LIST_ELECTRON_TARGETS",
          approved: true,
          observation_ms: 100,
          include_script_sources: false,
          source_capture_approved: false,
          limits: {
            max_frames: 200,
            max_dom_nodes: 2_000,
            max_scripts: 500,
            max_resources: 2_000,
            max_workers: 500,
            max_script_source_bytes: 1_048_576,
            max_total_script_source_bytes: 4_194_304,
          },
        },
      },
    ],
  },
  {
    name: "analyze_javascript_application",
    ...toolContractMetadata("analyze_javascript_application"),
    description:
      "Statically reconstruct one approved local ASAR or extracted JavaScript application without executing it. The default summary returns architecture/security counts, top evidence-backed findings, unknowns, and paged graph resource URIs; request detail=full only when the complete graph must be returned immediately. Identical inputs are deterministic, so do not repeat the call or reread full Evidence without a specific missing detail.",
    kind: "electron-provider",
    inputSchema: analyzeJavaScriptApplicationToolInputSchema,
    outputSchema: applicationOutputSchema,
    examples: [
      {
        title: "Analyze one approved local Electron application",
        input: {
          input_path: "/Applications/Example.app/Contents/Resources/app.asar",
          format: "auto",
          approved: true,
          source_map_read_approved: false,
          detail: "summary",
        },
      },
    ],
  },
  {
    name: "reconcile_javascript_runtime",
    ...toolContractMetadata("reconcile_javascript_runtime"),
    description:
      "Reconcile verified static JavaScript application graphs with existing passive web or Electron CDP Evidence. Exact captured-source digests take priority over caller-declared file/URL mappings; target, frame, script, and worker ambiguity remains explicit, and source-map authority stays separate.",
    kind: "electron-provider",
    inputSchema: reconcileJavaScriptRuntimeInputSchema,
    outputSchema: reconciliationOutputSchema,
    examples: [
      {
        title: "Reconcile one passive Electron capture",
        input: JAVASCRIPT_RUNTIME_RECONCILIATION_EXAMPLE,
      },
    ],
  },
] as const satisfies readonly ToolContract[];
