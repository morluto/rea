import { PLAYWRIGHT_TRACE_TOOL_CONTRACTS } from "./playwrightTraceToolContracts.js";
import { API_CONTRACT_TOOL_CONTRACTS } from "./apiContractToolContracts.js";
import { MAVEN_POM_TOOL_CONTRACTS } from "./mavenPomToolContracts.js";
import { NTFS_JOURNAL_TOOL_CONTRACTS } from "./ntfsJournalToolContracts.js";
import { applicationInventoryProjectionInputSchema } from "../domain/mobileApplicationGraphProjection.js";
import { z } from "zod";
import { EVIDENCE_FORMAT_REVISION } from "../domain/evidenceFormat.js";
import {
  featureTraceSummaryViewResultSchema,
  featureTraceViewResultSchema,
} from "../domain/analysisView/summarySchemas/featureTraceSummarySchemas.js";
import { applicationVersionComparisonResultSchema } from "../domain/javascript/javascriptApplicationVersionComparisonSchemas.js";
import { applicationFeatureTraceResultSchema } from "../domain/javascript/javascriptFeatureTraceSchemas.js";
import { javaScriptSemanticTraceResultSchema } from "../domain/javascript/javascriptSemanticTraceSchemas.js";
import { javaScriptExportShapeComparisonResultSchema } from "../domain/javascript/javascriptExportShapeComparisonSchemas.js";
import {
  compareApplicationVersionsRequestSchema,
  compareJavaScriptExportShapesRequestSchema,
  traceApplicationFeatureToolRequestSchema,
  traceJavaScriptSemanticsRequestSchema,
} from "./javascript/applicationWorkflowInputContracts.js";
import { reconstructionCoverageEvaluationInputSchema } from "../domain/reconstructionCoverageInput.js";
import { reconstructionClosureResultSchema } from "../domain/reconstructionCoverage.js";
import {
  reconstructionObligationLedgerInputSchema,
  reconstructionObligationLedgerSchema,
} from "../domain/reconstructionObligationLedgerSchemas.js";
import { androidApplicationProjectionResultSchema } from "../domain/android/androidApplication.js";
import { appleApplicationProjectionResultSchema } from "../domain/apple/appleApplication.js";
import { harmonyApplicationProjectionResultSchema } from "../domain/harmony/harmonyApplication.js";
import type { ToolContract } from "./toolContractTypes.js";
import {
  toolContractMetadata,
  evidenceEffects,
  toolEffects,
} from "./toolEffects.js";
import {
  readGuidanceSectionInputSchema,
  readGuidanceSectionOutputSchema,
  searchGuidanceInputSchema,
  searchGuidanceOutputSchema,
} from "./guidanceContracts.js";
import { GUIDED_WORKFLOWS_TOOL_CONTRACT } from "./guidedWorkflowToolContract.js";
import { COMPARE_SOURCE_TO_BUNDLE_TOOL_CONTRACT } from "./sourceToBundleToolContract.js";
import { COMPARE_STATIC_AND_OBSERVED_ENDPOINTS_TOOL_CONTRACT } from "./staticObservedEndpointsToolContract.js";
import { evidenceResultOf } from "./toolOutputSchemaPrimitives.js";
import {
  JAVASCRIPT_APPLICATION_VERSION_COMPARISON_EXAMPLE,
  JAVASCRIPT_FEATURE_TRACE_EXAMPLE,
} from "./javascript/javascriptApplicationWorkflowExamples.js";
import { JAVASCRIPT_EXPORT_SHAPE_COMPARISON_EXAMPLE } from "./javascript/javascriptExportShapeComparisonExample.js";
import {
  ANDROID_APPLICATION_GRAPH_EXAMPLE,
  APPLE_APPLICATION_GRAPH_EXAMPLE,
  HARMONY_APPLICATION_GRAPH_EXAMPLE,
  MACOS_APPLICATION_GRAPH_EXAMPLE,
} from "./mobileApplicationGraphExamples.js";

const traceOutputSchema = evidenceResultOf(
  z.union([
    applicationFeatureTraceResultSchema,
    featureTraceSummaryViewResultSchema,
    featureTraceViewResultSchema,
  ]),
);
const semanticTraceOutputSchema = evidenceResultOf(
  javaScriptSemanticTraceResultSchema,
);
const comparisonOutputSchema = evidenceResultOf(
  applicationVersionComparisonResultSchema,
);
const exportShapeComparisonOutputSchema = evidenceResultOf(
  javaScriptExportShapeComparisonResultSchema,
);
const reconstructionObligationLedgerOutputSchema = evidenceResultOf(
  reconstructionObligationLedgerSchema,
);
const HASH = "0".repeat(64);
const retained = (evidence_id: string) => ({
  kind: "retained-evidence" as const,
  evidence_id,
});

/** Provider-neutral graph workflow contracts shared by MCP and CLI adapters. */
export const APPLICATION_TOOL_CONTRACTS = [
  ...API_CONTRACT_TOOL_CONTRACTS,
  ...NTFS_JOURNAL_TOOL_CONTRACTS,
  ...PLAYWRIGHT_TRACE_TOOL_CONTRACTS,
  ...MAVEN_POM_TOOL_CONTRACTS,
  {
    name: "search_guidance",
    ...toolContractMetadata("search_guidance", toolEffects()),
    description:
      "Find installed REA workflow guidance by query words. Returns ranked sections, pages and locators for read_guidance_section; every non-generic word must match, with direct section matches ranked before matches spread across children. Reads documentation only, without accessing a target or provider.",
    kind: "application",
    inputSchema: searchGuidanceInputSchema,
    outputSchema: searchGuidanceOutputSchema,
    examples: [
      {
        title: "Find exact JavaScript module guidance",
        input: { query: "exact JavaScript module" },
      },
    ],
  },
  GUIDED_WORKFLOWS_TOOL_CONTRACT,
  {
    name: "read_guidance_section",
    ...toolContractMetadata("read_guidance_section", toolEffects()),
    description:
      "Retrieve a section selected by search_guidance from the installed REA guidance bundle. Reports stale locators and unavailable bundles explicitly. Returns documentation, not target observations or Evidence.",
    kind: "application",
    inputSchema: readGuidanceSectionInputSchema,
    outputSchema: readGuidanceSectionOutputSchema,
    examples: [],
  },
  {
    name: "trace_application_feature",
    cli: true,
    ...toolContractMetadata("trace_application_feature", evidenceEffects),
    description:
      "Trace a typed literal seed through every reachable part of an authenticated JavaScript Application Graph supplied as inline Evidence or exact same-session retained references. Original static, native, passive-runtime, inferred, and unknown authorities remain distinct; native addon handoffs never open a provider or execute the application. An optional view returns selected facts and retains the complete trace.",
    kind: "application",
    inputSchema: traceApplicationFeatureToolRequestSchema,
    outputSchema: traceOutputSchema,
    examples: [
      {
        title: "Trace one module seed through a retained application graph",
        input: JAVASCRIPT_FEATURE_TRACE_EXAMPLE,
      },
      {
        title: "Use exact Evidence already retained in this session",
        input: {
          ...JAVASCRIPT_FEATURE_TRACE_EXAMPLE,
          application: retained(
            JAVASCRIPT_FEATURE_TRACE_EXAMPLE.application.evidence_id,
          ),
        },
      },
    ],
  },
  {
    name: "trace_javascript_semantics",
    cli: true,
    ...toolContractMetadata("trace_javascript_semantics", evidenceEffects),
    description:
      "Trace static JavaScript data-flow, direct call/return, and closure relations from inline application Evidence or an exact same-session retained reference. Dynamic or unsupported semantics remain explicit unknowns; static reachability never claims runtime execution.",
    kind: "application",
    inputSchema: traceJavaScriptSemanticsRequestSchema,
    outputSchema: semanticTraceOutputSchema,
    examples: [
      {
        title: "Trace backward provenance from one semantic node",
        input: {
          application: JAVASCRIPT_FEATURE_TRACE_EXAMPLE.application,
          query: {
            seed: { kind: "semantic-node", node_id: `jsrg_node_${HASH}` },
            direction: "backward-provenance",
          },
        },
      },
    ],
  },
  {
    name: "compare_application_versions",
    cli: true,
    ...toolContractMetadata("compare_application_versions", evidenceEffects),
    description:
      "Compare two authenticated JavaScript Application Graph versions, supplied inline or by exact retained reference. Returns added, removed, changed, ambiguous and unknown entities with the full changed_from graph. Pairing uses unique exact digest, source-map, structural or semantic-key tiers; no fuzzy or module-ordinal pairing.",
    kind: "application",
    inputSchema: compareApplicationVersionsRequestSchema,
    outputSchema: comparisonOutputSchema,
    examples: [
      {
        title: "Compare authenticated static and reconciled application graphs",
        input: JAVASCRIPT_APPLICATION_VERSION_COMPARISON_EXAMPLE,
      },
      {
        title: "Use exact Evidence already retained in this session",
        input: {
          ...JAVASCRIPT_APPLICATION_VERSION_COMPARISON_EXAMPLE,
          left: retained(
            JAVASCRIPT_APPLICATION_VERSION_COMPARISON_EXAMPLE.left.evidence_id,
          ),
          right: retained(
            JAVASCRIPT_APPLICATION_VERSION_COMPARISON_EXAMPLE.right.evidence_id,
          ),
        },
      },
    ],
  },
  COMPARE_STATIC_AND_OBSERVED_ENDPOINTS_TOOL_CONTRACT,
  COMPARE_SOURCE_TO_BUNDLE_TOOL_CONTRACT,
  {
    name: "compare_javascript_export_shapes",
    cli: true,
    ...toolContractMetadata(
      "compare_javascript_export_shapes",
      evidenceEffects,
    ),
    description:
      "Compare static return-property shapes for one exact module/export on each authenticated JavaScript Application Graph, inline or retained. Variants pair only by reciprocal unique literal discriminants. Returns JSON Pointer changes while keeping property presence separate from value resolution: complete property coverage can establish an addition/removal even when values are unresolved. Dynamic values, incomplete coverage and unpaired variants stay unknown. Does not execute JavaScript; runtime behavior needs a separate probe.",
    kind: "application",
    inputSchema: compareJavaScriptExportShapesRequestSchema,
    outputSchema: exportShapeComparisonOutputSchema,
    examples: [
      {
        title:
          "Report observed return-property presence when static values stay unknown",
        input: JAVASCRIPT_EXPORT_SHAPE_COMPARISON_EXAMPLE,
      },
      {
        title: "Use exact Evidence already retained in this session",
        input: {
          ...JAVASCRIPT_EXPORT_SHAPE_COMPARISON_EXAMPLE,
          left: retained(
            JAVASCRIPT_EXPORT_SHAPE_COMPARISON_EXAMPLE.left.evidence_id,
          ),
          right: retained(
            JAVASCRIPT_EXPORT_SHAPE_COMPARISON_EXAMPLE.right.evidence_id,
          ),
        },
      },
    ],
  },
  {
    name: "build_reconstruction_obligation_ledger",
    cli: true,
    ...toolContractMetadata(
      "build_reconstruction_obligation_ledger",
      evidenceEffects,
    ),
    description:
      "Build a deterministic reconstruction-obligation ledger from an authenticated Evidence bundle, reviewed obligations and an explicit reconstruction manifest. Returns the complete ledger, closure digest and typed diagnostics. Duplicate owners, missing cases or parser/type, weak verifier authority, unenumerated claims, contradictions, dependencies and residual unknowns fail closed; static candidates remain candidates.",
    kind: "application",
    inputSchema: reconstructionObligationLedgerInputSchema,
    outputSchema: reconstructionObligationLedgerOutputSchema,
    examples: [
      {
        title: "Generate the complete obligation ledger",
        input: {
          evidence_bundle: {
            evidence_format: EVIDENCE_FORMAT_REVISION,
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
            bindings: [],
            contradictions: [],
          },
        },
      },
    ],
  },
  {
    name: "evaluate_reconstruction_coverage",
    cli: true,
    ...toolContractMetadata("evaluate_reconstruction_coverage", toolEffects()),
    description:
      "Check evidence-backed reconstruction coverage for one named boundary. Missing ownership or inventory is partial; stale, weak, truncated, skipped, unresolved or conflicting verifier proof is unknown. Contradictions, failed proof, missing owners and authority-routing failures fail closed.",
    kind: "application",
    inputSchema: reconstructionCoverageEvaluationInputSchema,
    outputSchema: reconstructionClosureResultSchema,
    examples: [
      {
        title: "Evaluate one replacement boundary",
        input: {
          coverage: {
            evidence_bundle: {
              evidence_format: EVIDENCE_FORMAT_REVISION,
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
            boundaries: [
              {
                boundary_id: "replacement.cli",
                title: "CLI replacement",
                required_surface_ids: ["cli.help"],
                required_claim_ids: ["claim.cli.help"],
                required_package_proof_kinds: [
                  "clean-install",
                  "authority-independence",
                ],
                allowed_dispositions: [],
                allowed_unknown_ids: [],
              },
            ],
          },
          boundary_id: "replacement.cli",
        },
      },
    ],
  },
  {
    name: "project_android_application_graph",
    cli: true,
    ...toolContractMetadata(
      "project_android_application_graph",
      evidenceEffects,
    ),
    description:
      "Build a static Android application inventory from the authenticated nested inventory Evidence returned by inspect_artifact for an APK. Returns component paths/hashes, runtime-family hints and path-based bridge hypotheses. Does not decode DEX, execute the APK or establish runtime calls.",
    kind: "application",
    inputSchema: applicationInventoryProjectionInputSchema,
    outputSchema: evidenceResultOf(androidApplicationProjectionResultSchema),
    examples: [
      {
        title:
          "Project APK inventory Evidence into an Android application graph",
        input: ANDROID_APPLICATION_GRAPH_EXAMPLE,
      },
    ],
  },
  {
    name: "project_apple_application_graph",
    cli: true,
    ...toolContractMetadata("project_apple_application_graph", evidenceEffects),
    description:
      "Build a static Apple application inventory from the authenticated nested inventory Evidence returned by inspect_artifact for an IPA, .app directory, ZIP or DMG. Returns application roots, nested-bundle roles, launchd plists, component paths/hashes, runtime hints and bridge hypotheses. Roles follow path conventions; plist/CMS semantics and runtime calls are not established.",
    kind: "application",
    inputSchema: applicationInventoryProjectionInputSchema,
    outputSchema: evidenceResultOf(appleApplicationProjectionResultSchema),
    examples: [
      {
        title: "Project IPA inventory Evidence into an Apple application graph",
        input: APPLE_APPLICATION_GRAPH_EXAMPLE,
      },
      {
        title:
          "Project a macOS .app directory inventory into its bundle anatomy",
        input: MACOS_APPLICATION_GRAPH_EXAMPLE,
      },
    ],
  },
  {
    name: "project_harmony_application_graph",
    cli: true,
    ...toolContractMetadata(
      "project_harmony_application_graph",
      evidenceEffects,
    ),
    description:
      "Build a static HarmonyOS inventory from the authenticated nested inventory Evidence returned by inspect_artifact for a HAP, HSP or App Pack. Returns packaging hints, component paths/hashes, child packages, runtime hints, unclassified components and path-based N-API bridge hypotheses. Does not decode Ark bytecode, parse manifest semantics or establish runtime calls.",
    kind: "application",
    inputSchema: applicationInventoryProjectionInputSchema,
    outputSchema: evidenceResultOf(harmonyApplicationProjectionResultSchema),
    examples: [
      {
        title:
          "Project HAP inventory Evidence into a HarmonyOS application graph",
        input: HARMONY_APPLICATION_GRAPH_EXAMPLE,
      },
    ],
  },
] as const satisfies readonly ToolContract[];
