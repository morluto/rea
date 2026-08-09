import { applicationVersionComparisonResultSchema } from "../domain/javascriptApplicationVersionComparisonSchemas.js";
import { z } from "zod";
import { applicationFeatureTraceResultSchema } from "../domain/javascriptFeatureTraceSchemas.js";
import { javaScriptSemanticTraceResultSchema } from "../domain/javascriptSemanticTraceSchemas.js";
import { javaScriptExportShapeComparisonResultSchema } from "../domain/javascriptExportShapeComparisonSchemas.js";
import { sourceToBundleComparisonResultSchema } from "../domain/sourceToBundleComparisonSchemas.js";
import {
  compareApplicationVersionsRequestSchema,
  compareJavaScriptExportShapesRequestSchema,
  compareSourceToBundleRequestSchema,
  traceApplicationFeatureRequestSchema,
  traceJavaScriptSemanticsRequestSchema,
} from "./applicationWorkflowInputContracts.js";
import {
  controlledReplayInputSchema,
  controlledReplayOutputSchema,
} from "../domain/javascriptReplay.js";
import {
  nodeCharacterizationExecutionInputSchema,
  nodeCharacterizationExecutionOutputSchema,
  nodeCharacterizationPreparationInputSchema,
  nodeCharacterizationPreparationOutputSchema,
} from "../domain/nodeRuntimeCharacterization.js";
import {
  reconstructionCoverageCommitInputSchema,
  reconstructionCoverageCommitOutputSchema,
  reconstructionCoverageQueryInputSchema,
} from "../application/ReconstructionCoverageService.js";
import { reconstructionClosureResultSchema } from "../domain/reconstructionCoverage.js";
import {
  reconstructionObligationLedgerInputSchema,
  reconstructionObligationLedgerPageSchema,
} from "../domain/reconstructionObligationLedgerSchemas.js";
import {
  reconstructionReadinessInputSchema,
  reconstructionReadinessReportSchema,
} from "../domain/reconstructionReadinessSchemas.js";
import { jsonObjectSchema } from "../domain/jsonValue.js";
import type { ToolContract } from "./toolContracts.js";
import { toolContractMetadata } from "./toolEffects.js";
import { evidenceResultOf } from "./toolOutputSchemas.js";
import {
  JAVASCRIPT_APPLICATION_VERSION_COMPARISON_EXAMPLE,
  JAVASCRIPT_EXPORT_SHAPE_COMPARISON_EXAMPLE,
  JAVASCRIPT_FEATURE_TRACE_EXAMPLE,
  SOURCE_TO_BUNDLE_COMPARISON_EXAMPLE,
} from "./javascriptApplicationWorkflowExamples.js";
import { RECONSTRUCTION_READINESS_EXAMPLE } from "./reconstructionReadinessExample.js";

const traceOutputSchema = evidenceResultOf(applicationFeatureTraceResultSchema);
const semanticTraceOutputSchema = evidenceResultOf(
  javaScriptSemanticTraceResultSchema,
);
const comparisonOutputSchema = evidenceResultOf(
  applicationVersionComparisonResultSchema,
);
const sourceToBundleOutputSchema = evidenceResultOf(
  sourceToBundleComparisonResultSchema,
);
const exportShapeComparisonOutputSchema = evidenceResultOf(
  javaScriptExportShapeComparisonResultSchema,
);
const reconstructionObligationLedgerOutputSchema = evidenceResultOf(
  reconstructionObligationLedgerPageSchema,
);
const reconstructionReadinessOutputSchema = evidenceResultOf(
  reconstructionReadinessReportSchema
    .pick({
      schema: true,
      schema_version: true,
      report_id: true,
      source_digest: true,
      report_digest: true,
      status: true,
      summary: true,
      metrics: true,
    })
    .extend({
      report_resource_uri: z
        .string()
        .regex(
          /^rea:\/\/evidence\/ev_[a-f0-9]{64}\/reconstruction-readiness-report$/u,
        ),
    }),
);
const HASH = "0".repeat(64);
const NODE_PREPARATION_EXAMPLE = jsonObjectSchema.parse({
  preparation_approved: true,
  selected_alias: "bundle",
  expected_effect: "pure",
  instrumentation: {
    artifact_path: "/approved/bundle.js",
    artifact_sha256: HASH,
    selection: {
      byte_start: 100,
      byte_end: 120,
      selected_sha256: HASH,
      export_name: "selected",
    },
  },
  replay: {
    mode: "plan",
    left: {
      modules: [
        {
          alias: "bundle",
          path: "/approved/bundle.js",
          format: "commonjs-factory",
          role: "module",
          dependencies: {},
        },
      ],
      entry_alias: "bundle",
      entry_export: "selected",
    },
    cases: [{ case_id: "empty", arguments: [""] }],
  },
});

const COVERAGE_WORKSPACE_EXAMPLE = jsonObjectSchema.parse({
  schema_version: 1,
  workspace_id: `rcw_${HASH}`,
  name: "replacement",
  revision: 1,
  previous_revision_sha256: null,
  revision_sha256: HASH,
  evidence_bundle: {
    bundle_version: 2,
    artifacts: [],
    providers: [],
    environments: [],
    scenarios: [],
    captures: [],
    unknowns: [],
    records: [],
  },
  artifacts: [],
  surfaces: [],
  owners: [],
  claims: [],
  verifier_contracts: [],
  verifier_results: [],
  residual_unknown_ids: [],
  contradictions: [],
  package_proofs: [],
  boundaries: [],
});

/** Provider-neutral graph workflow contracts shared by MCP and CLI adapters. */
export const APPLICATION_TOOL_CONTRACTS = [
  {
    name: "trace_application_feature",
    ...toolContractMetadata("trace_application_feature"),
    description:
      "Trace a typed literal seed through an authenticated JavaScript Application Graph supplied as full Evidence or an Evidence ID returned earlier in this session. Explicit direction, depth, node, edge, and path bounds apply. Original static, native, passive-runtime, inferred, and unknown authorities remain distinct; native addon handoffs never open a provider or execute the application.",
    kind: "application",
    inputSchema: traceApplicationFeatureRequestSchema,
    outputSchema: traceOutputSchema,
    examples: [
      {
        title: "Trace one module seed through a retained application graph",
        input: JAVASCRIPT_FEATURE_TRACE_EXAMPLE,
      },
    ],
  },
  {
    name: "trace_javascript_semantics",
    ...toolContractMetadata("trace_javascript_semantics"),
    description:
      "Trace bounded static JavaScript data-flow, direct call/return, and closure relations from authenticated analyze_javascript_application v2 Evidence. Queries declare direction and exact node, relation, depth, function, module, and page limits. Dynamic or unsupported semantics remain explicit unknowns; static reachability never claims runtime execution.",
    kind: "application",
    inputSchema: traceJavaScriptSemanticsRequestSchema,
    outputSchema: semanticTraceOutputSchema,
    examples: [
      {
        title: "Trace backward provenance from one semantic node",
        input: {
          application_evidence_id: `ev_${HASH}`,
          query: {
            seed: { kind: "semantic-node", node_id: `jsrg_node_${HASH}` },
            direction: "backward-provenance",
            source_map_authority: { authority: "none" },
          },
        },
      },
    ],
  },
  {
    name: "compare_application_versions",
    ...toolContractMetadata("compare_application_versions"),
    description:
      "Compare two authenticated JavaScript Application Graph versions supplied as full Evidence or Evidence IDs returned earlier in this session. Uses unique-only exact digest, module source digest, source-map identity, structural fingerprint, and non-module semantic-key tiers. Reports added, removed, changed, ambiguous, and unknown entities plus a bounded changed_from graph without fuzzy or module-ordinal pairing.",
    kind: "application",
    inputSchema: compareApplicationVersionsRequestSchema,
    outputSchema: comparisonOutputSchema,
    examples: [
      {
        title: "Compare authenticated static and reconciled application graphs",
        input: JAVASCRIPT_APPLICATION_VERSION_COMPARISON_EXAMPLE,
      },
    ],
  },
  {
    name: "compare_source_to_bundle",
    ...toolContractMetadata("compare_source_to_bundle"),
    description:
      "Compare a cryptographically committed HistoricalSourceGraph/v1 with authenticated JavaScript Application Graph Evidence supplied directly or by session Evidence ID. Uses explicit exact-digest, source-map path, current-path, suffix, and basename signals with stable weights. Classifies unchanged, modified, removed, split, merged, duplicated, and unknown; incomplete coverage and ambiguous weak signals never become absence or forced matches.",
    kind: "application",
    inputSchema: compareSourceToBundleRequestSchema,
    outputSchema: sourceToBundleOutputSchema,
    examples: [
      {
        title:
          "Compare committed historical source with a shipped bundle graph",
        input: SOURCE_TO_BUNDLE_COMPARISON_EXAMPLE,
      },
    ],
  },
  {
    name: "compare_javascript_export_shapes",
    ...toolContractMetadata("compare_javascript_export_shapes"),
    description:
      "Compare bounded static return shapes for one exact module/export selector on each authenticated JavaScript Application Graph, supplied as full Evidence or session Evidence IDs. Variants pair only by reciprocal unique literal discriminants; dynamic values, incomplete properties, and ambiguous variants remain unknown. Reports JSON Pointer changes and recommends controlled replay separately without executing JavaScript.",
    kind: "application",
    inputSchema: compareJavaScriptExportShapesRequestSchema,
    outputSchema: exportShapeComparisonOutputSchema,
    examples: [
      {
        title: "Compare one exact parser export without execution",
        input: JAVASCRIPT_EXPORT_SHAPE_COMPARISON_EXAMPLE,
      },
    ],
  },
  {
    name: "run_controlled_replay",
    ...toolContractMetadata("run_controlled_replay"),
    description:
      "Plan or execute a content-bound extracted-module JavaScript replay inside the Linux Bubblewrap, seccomp, and cgroup boundary. Execution requires approved: true and the exact plan digest. Supports deterministic boundary cases and optional left/right differential comparison; observations have controlled-replay authority and do not claim real application runtime behavior.",
    kind: "application",
    inputSchema: controlledReplayInputSchema,
    outputSchema: controlledReplayOutputSchema,
    examples: [
      {
        title: "Plan one extracted ESM parser replay",
        input: {
          mode: "plan",
          left: {
            modules: [
              {
                alias: "parser",
                path: "/approved/parser.mjs",
                format: "esm",
                role: "module",
                dependencies: {},
              },
            ],
            entry_alias: "parser",
            entry_export: "default",
          },
          cases: [{ case_id: "empty", arguments: [""] }],
          determinism: {
            clock_iso: "2000-01-01T00:00:00.000Z",
            random_seed: 0,
            locale: "en-US",
            timezone: "UTC",
            platform: "linux",
          },
          limits: {
            wall_time_ms: 3000,
            memory_bytes: 134217728,
            tasks: 8,
            cpu_quota_percent: 50,
            tmpfs_bytes: 16777216,
            module_bytes: 4194304,
            input_bytes: 262144,
            protocol_bytes: 16777216,
            output_bytes: 524288,
            stderr_bytes: 32768,
            result_depth: 16,
            result_nodes: 10000,
          },
        },
      },
    ],
  },
  {
    name: "prepare_node_characterization",
    ...toolContractMetadata("prepare_node_characterization"),
    description:
      "Prepare a hash-bound Node/JavaScript characterization plan and deterministic reversible export transformation without executing target code. The exact source, selected byte range, runtime closure, sandbox profile, cases, and limits are committed for separate execution approval.",
    kind: "application",
    inputSchema: nodeCharacterizationPreparationInputSchema,
    outputSchema: nodeCharacterizationPreparationOutputSchema,
    examples: [
      {
        title: "Prepare one exact bundled callable characterization",
        input: NODE_PREPARATION_EXAMPLE,
      },
    ],
  },
  {
    name: "execute_node_characterization",
    ...toolContractMetadata("execute_node_characterization"),
    description:
      "Recompute and execute one separately approved exact Node characterization plan in the owned controlled-replay boundary. Returns transformation, replay, cleanup, and provider-neutral characterization Evidence v2; stale plans fail before execution.",
    kind: "application",
    inputSchema: nodeCharacterizationExecutionInputSchema,
    outputSchema: nodeCharacterizationExecutionOutputSchema,
    examples: [
      {
        title: "Execute one approved exact characterization plan",
        input: {
          execution_approved: true,
          approved_plan_sha256: HASH,
          preparation: NODE_PREPARATION_EXAMPLE,
        },
      },
    ],
  },
  {
    name: "build_reconstruction_obligation_ledger",
    ...toolContractMetadata("build_reconstruction_obligation_ledger"),
    description:
      "Generate one deterministic page of a ReconstructionObligationLedger/v1 from an authenticated Evidence v2 bundle, reviewed obligations, and an explicit reconstruction manifest. Static candidates remain candidates; duplicate ownership, missing original or reconstruction cases, missing parser/type, weak verifier authority, unenumerated claims, contradictions, dependencies, and residual unknowns fail closed. Every page carries the same full-ledger closure digest and typed per-obligation diagnostics.",
    kind: "application",
    inputSchema: reconstructionObligationLedgerInputSchema,
    outputSchema: reconstructionObligationLedgerOutputSchema,
    examples: [
      {
        title: "Generate the first obligation-ledger page",
        input: {
          evidence_bundle: {
            bundle_version: 2,
            artifacts: [],
            providers: [],
            environments: [],
            scenarios: [],
            captures: [],
            unknowns: [],
            records: [],
          },
          reviewed_obligations: [],
          manifest: {
            schema_version: 1,
            bindings: [],
            contradictions: [],
          },
          limits: { max_obligations: 1_000 },
          page: { offset: 0, limit: 50 },
        },
      },
    ],
  },
  {
    name: "evaluate_reconstruction_readiness",
    ...toolContractMetadata("evaluate_reconstruction_readiness"),
    description:
      "Evaluate the fixed nine-stage public reconstruction journey into a deterministic ReconstructionReadinessReport/v1. Exact capability limits, provider routing, CLI/MCP status parity, bounded authority, partial-order comparison, contradictions, obligation closure, cleanup, and replay digests fail closed. Aggregate pass is emitted only when every required stage and check passes with attributable Evidence.",
    kind: "application",
    inputSchema: reconstructionReadinessInputSchema,
    outputSchema: reconstructionReadinessOutputSchema,
    examples: [
      {
        title: "Evaluate the complete synthetic reconstruction journey",
        input: RECONSTRUCTION_READINESS_EXAMPLE,
      },
    ],
  },
  {
    name: "commit_reconstruction_coverage",
    ...toolContractMetadata("commit_reconstruction_coverage"),
    description:
      "Atomically commit one canonical evidence-backed reconstruction coverage workspace revision under an approved root. CAS revisions reject lost updates; every Evidence and residual-unknown reference must resolve in the embedded canonical bundle.",
    kind: "application",
    inputSchema: reconstructionCoverageCommitInputSchema,
    outputSchema: reconstructionCoverageCommitOutputSchema,
    examples: [
      {
        title: "Commit the first canonical coverage revision",
        input: {
          approved: true,
          workspace_path: "/approved/coverage.json",
          expected_revision: null,
          workspace: COVERAGE_WORKSPACE_EXAMPLE,
        },
      },
    ],
  },
  {
    name: "query_reconstruction_coverage",
    ...toolContractMetadata("query_reconstruction_coverage"),
    description:
      "Evaluate one named reconstruction boundary from a canonical coverage workspace. Missing ownership or inventory is partial; stale, weak, truncated, skipped, or unresolved proof is unknown; contradictions, failed proof, missing owners, and authority routing fail closed.",
    kind: "application",
    inputSchema: reconstructionCoverageQueryInputSchema,
    outputSchema: reconstructionClosureResultSchema,
    examples: [
      {
        title: "Evaluate one replacement boundary",
        input: {
          workspace_path: "/approved/coverage.json",
          boundary_id: "replacement.cli",
        },
      },
    ],
  },
] as const satisfies readonly ToolContract[];

/** Resolve one named application contract without relying on array position. */
export function applicationToolContract(
  name: "trace_application_feature",
): (typeof APPLICATION_TOOL_CONTRACTS)[0];
export function applicationToolContract(
  name: "trace_javascript_semantics",
): (typeof APPLICATION_TOOL_CONTRACTS)[1];
export function applicationToolContract(
  name: "compare_application_versions",
): (typeof APPLICATION_TOOL_CONTRACTS)[2];
export function applicationToolContract(
  name: "compare_source_to_bundle",
): (typeof APPLICATION_TOOL_CONTRACTS)[3];
export function applicationToolContract(
  name: "compare_javascript_export_shapes",
): (typeof APPLICATION_TOOL_CONTRACTS)[4];
export function applicationToolContract(
  name: "run_controlled_replay",
): (typeof APPLICATION_TOOL_CONTRACTS)[5];
export function applicationToolContract(
  name: "prepare_node_characterization",
): (typeof APPLICATION_TOOL_CONTRACTS)[6];
export function applicationToolContract(
  name: "execute_node_characterization",
): (typeof APPLICATION_TOOL_CONTRACTS)[7];
export function applicationToolContract(
  name: "build_reconstruction_obligation_ledger",
): (typeof APPLICATION_TOOL_CONTRACTS)[8];
export function applicationToolContract(
  name: "evaluate_reconstruction_readiness",
): (typeof APPLICATION_TOOL_CONTRACTS)[9];
export function applicationToolContract(
  name: "commit_reconstruction_coverage",
): (typeof APPLICATION_TOOL_CONTRACTS)[10];
export function applicationToolContract(
  name: "query_reconstruction_coverage",
): (typeof APPLICATION_TOOL_CONTRACTS)[11];
export function applicationToolContract(
  name: (typeof APPLICATION_TOOL_CONTRACTS)[number]["name"],
): (typeof APPLICATION_TOOL_CONTRACTS)[number] {
  const contract = APPLICATION_TOOL_CONTRACTS.find(
    ({ name: candidate }) => candidate === name,
  );
  if (contract === undefined)
    throw new Error(`Missing application tool contract: ${name}`);
  return contract;
}
