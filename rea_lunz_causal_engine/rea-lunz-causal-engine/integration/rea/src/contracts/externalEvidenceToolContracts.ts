import { z } from "zod";

import type { ToolContract } from "./toolContractTypes.js";
import { toolContractMetadata } from "./toolEffects.js";
import { evidenceResultOf } from "./toolOutputSchemaPrimitives.js";

const packageInput = z.strictObject({
  name: z.string().min(1).max(214),
  version: z.string().min(1).max(128).optional(),
});

const targetFactInput = z.strictObject({
  id: z.string().min(1).max(200),
  kind: z.enum(["package", "version", "symbol", "file", "api", "cve", "behavior", "hash", "unknown"]),
  value: z.string().min(1).max(512),
  evidence_id: z.string().min(1).max(200).optional(),
});

const externalGraphResultSchema = z.strictObject({
  schema_version: z.literal("rea-lunz.external-evidence-result.v1"),
  status: z.enum(["validated", "provisional", "conflicted", "rejected", "insufficient_evidence"]),
  query: z.string(),
  graph: z.unknown(),
  validation: z.unknown(),
  quality_report: z.unknown(),
  source_count: z.number().int().min(0),
  accepted_source_count: z.number().int().min(0),
  warnings: z.array(z.string()),
  cache: z.strictObject({ entries: z.number().int().min(0), ttl_ms: z.number().int().min(0) }),
});

const graphValidationResultSchema = z.unknown();

const fidelityObservationInput = z.strictObject({
  id: z.string().min(1).max(200).optional(),
  path: z.string().min(1).max(1000),
  origin: z.enum(["original_source", "runtime_observation", "static_analysis", "decompiled", "pseudocode", "generated", "metadata", "stub", "unknown"]),
  completeness: z.enum(["complete", "partial", "summary", "not_visible"]),
  source_visible: z.boolean().optional(),
  attempted_simulation: z.boolean().optional(),
  content_excerpt: z.string().max(12000).optional(),
  limitations: z.array(z.string().max(500)).max(30).optional(),
  issues: z.array(z.enum(["source_diff", "behavior_mismatch", "missing_dependency", "unresolved_dynamic_dispatch", "test_failure", "truncated_decompilation", "no_source_map", "unsupported_construct"])).max(30).optional(),
  source_evidence_ids: z.array(z.string().max(200)).max(30).optional(),
});

const fidelityResultSchema = z.unknown();

export const EXTERNAL_EVIDENCE_TOOL_CONTRACTS = [
  {
    name: "investigate_external_evidence_graph",
    ...toolContractMetadata("investigate_external_evidence_graph"),
    description: "Search allowlisted external technical sources, construct a typed evidence graph with source-bound support and candidate causal edges, validate provenance and contradictions, and return an auditable quality report. Local target facts are only linked when their REA Evidence identifier exists and contains the exact fact value. Raw source code is not sent to the web search provider.",
    kind: "application",
    inputSchema: z.strictObject({
      query: z.string().min(3).max(500),
      packages: z.array(packageInput).max(25).default([]),
      target_facts: z.array(targetFactInput).max(50).default([]),
      max_sources: z.number().int().min(1).max(16).default(10),
    }),
    outputSchema: evidenceResultOf(externalGraphResultSchema),
    examples: [{ title: "Investigate an observed package issue", input: { query: "Possible Electron preload compatibility issue", packages: [{ name: "electron", version: "30.0.0" }], target_facts: [], max_sources: 10 } }],
  },
  {
    name: "validate_external_evidence_graph",
    ...toolContractMetadata("validate_external_evidence_graph"),
    description: "Independently validate a supplied evidence graph: source URL policy, source identity and excerpt digests, node and edge integrity, evidence references, confidence bounds, contradictions, and independent source domains. Invalid edges are rejected instead of silently accepted.",
    kind: "application",
    inputSchema: z.strictObject({ graph: z.unknown() }),
    outputSchema: evidenceResultOf(graphValidationResultSchema),
    examples: [{ title: "Validate a previously generated graph", input: { graph: { schema_version: "rea-lunz.external-evidence-graph.v1", nodes: [], edges: [], sources: [] } } }],
  },
  {
    name: "generate_code_fidelity_report",
    ...toolContractMetadata("generate_code_fidelity_report"),
    description: "Generate a code visibility, confidence, and reconstruction-fidelity report from supplied REA observations. Calls out unobservable code paths, simulated or inferred behavior, decompilation limits, known mismatches, missing dependencies, and areas not verified against original behavior.",
    kind: "application",
    inputSchema: z.strictObject({
      target: z.string().min(1).max(1000),
      observations: z.array(fidelityObservationInput).max(300),
    }),
    outputSchema: evidenceResultOf(fidelityResultSchema),
    examples: [{ title: "Report decompilation and source visibility", input: { target: "Example application", observations: [{ path: "src/feature.ts", origin: "generated", completeness: "partial", attempted_simulation: true, limitations: ["Original source was unavailable"], issues: ["missing_dependency"] }] } }],
  },
] as const satisfies readonly ToolContract[];
