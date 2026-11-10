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
    "Validate and inspect local WASM with caller-supplied WABT 1.0.42, without executing it or fetching dependencies. Returns artifact SHA-256, sections, import/export WAT forms and decoded WAT; custom-section interpretation warnings do not invalidate the core module. Default complete returns full Evidence; detail summary retains it for inspect_analysis_view kind wasm using normalized_result.parent_evidence_id, with import/export rows or UTF-16 WAT pages. Delivery does not change analysis. Optional JavaScript glue associations preserve ambiguous candidates. Configure absolute REA_WABT_BIN_DIRECTORY. Per-call command_timeout_ms, input/tool/output, interface-precision and auxiliary-path budgets are independent; reported limit errors identify the control to adjust. No installation or original-source claim.",
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
