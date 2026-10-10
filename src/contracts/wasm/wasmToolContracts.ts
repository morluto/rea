import {
  inspectWasmArtifactInputSchema,
  wasmArtifactSchema,
} from "../../domain/wasm/wasmArtifact.js";
import type { ToolContract } from "../toolContractTypes.js";
import { toolContractMetadata } from "../toolEffects.js";
import { evidenceResultOf } from "../toolOutputSchemaPrimitives.js";
/** Optional caller-supplied WABT capability with target-free CLI/MCP parity. */
export const WASM_TOOL_CONTRACTS = [
  {
    name: "inspect_wasm_artifact",
    ...toolContractMetadata("inspect_wasm_artifact"),
    kind: "artifact-provider",
    description:
      "Validate an explicit local WASM artifact with caller-supplied WABT 1.0.42, retain exact byte SHA-256, sections, upstream import/export WAT forms and decoded WAT inline as Evidence. Optionally associate selected JavaScript glue literals with explicit local candidates while preserving ambiguous URL/basename matches. Configure absolute REA_WABT_BIN_DIRECTORY. No installation, implicit fetch, WASM execution or original-source claim.",
    inputSchema: inspectWasmArtifactInputSchema,
    outputSchema: evidenceResultOf(wasmArtifactSchema),
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
  },
] as const satisfies readonly ToolContract[];
