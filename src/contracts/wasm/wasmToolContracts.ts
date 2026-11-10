import { COMPARE_WASM_INTERFACES_CONTRACT } from "./wasmComparisonContracts.js";
import {
  inspectWasmArtifactInputSchema,
  wasmArtifactSchema,
} from "../../domain/wasm/wasmArtifact.js";
import type { ToolContract } from "../toolContractTypes.js";
import { toolContractMetadata } from "../toolEffects.js";
import {
  analysisDetailSchema,
  analysisDetailOutputSchemaOf,
} from "../analysisDetail.js";
import { wasmArtifactSummaryViewResultSchema } from "../../domain/analysisView/analysisView.js";

/** Delivery selection does not change the provider input or original Evidence. */
export const wasmArtifactInspectionInputSchema =
  inspectWasmArtifactInputSchema.extend({
    detail: analysisDetailSchema,
  });
/** Optional caller-supplied WABT capability with target-free CLI/MCP parity. */
export const INSPECT_WASM_ARTIFACT_CONTRACT = {
  name: "inspect_wasm_artifact",
  ...toolContractMetadata("inspect_wasm_artifact"),
  kind: "artifact-provider",
  requiresActiveTarget: true,
  description:
    'Validate an explicit local WASM artifact with caller-supplied WABT 1.0.42. Optional custom-section interpretation errors do not invalidate the core module; warnings and name-section interpretation status remain in the result. Omitted or complete detail returns exact byte SHA-256, sections, upstream import/export WAT forms and decoded WAT inline as Evidence. For counts, validation and WAT identity without WAT text, pass detail: "summary" on this first call; it retains the complete original Evidence and returns the same typed summary as inspect_analysis_view, avoiding oversized complete delivery. Read exact imports/exports or WAT pages with inspect_analysis_view using normalized_result.parent_evidence_id. Delivery selection does not change analysis, provider inputs or source identity. Adjust command_timeout_ms for each WABT command (default 30000 ms), separately from the client deadline. max_artifact_paths admits auxiliary candidate/glue selections (default 16 paths per list). max_interface_bytes selects typed interface precision admission (default 32MiB), independently from producer text retention. max_input_bytes, max_tool_bytes and max_output_bytes select independent per-call file/tool/combined-command-output allowances with unchanged defaults of 8/64/32 MiB; limit errors name the exhausted control and retry action. Optionally associate selected JavaScript glue literals with explicit local candidates while preserving ambiguous URL/basename matches. Configure absolute REA_WABT_BIN_DIRECTORY. No installation, implicit fetch, WASM execution or original-source claim.',
  inputSchema: wasmArtifactInspectionInputSchema,
  outputSchema: analysisDetailOutputSchemaOf(
    wasmArtifactSchema,
    wasmArtifactSummaryViewResultSchema,
  ),
  examples: [
    {
      title: "Inspect a selected local WASM module",
      input: {
        path: "/artifacts/module.wasm",
        glue_paths: [],
        candidate_paths: [],
      },
    },
  ],
} as const satisfies ToolContract;

/** Keep the public catalog in its existing order, using its named contract. */
export const WASM_TOOL_CONTRACTS = [
  INSPECT_WASM_ARTIFACT_CONTRACT,
  COMPARE_WASM_INTERFACES_CONTRACT,
] as const;
