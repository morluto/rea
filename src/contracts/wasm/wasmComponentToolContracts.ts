import {
  inspectWasmComponentInputSchema,
  wasmComponentSchema,
} from "../../domain/wasm/wasmComponent.js";
import type { ToolContract } from "../toolContractTypes.js";
import { evidenceEffects, toolContractMetadata } from "../toolEffects.js";
import { evidenceResultOf } from "../toolOutputSchemaPrimitives.js";

/** Bundled in-process component decoder; independent of WABT and binary sessions. */
export const WASM_COMPONENT_TOOL_CONTRACTS = [
  {
    name: "inspect_wasm_component",
    availability: "standalone",
    cli: true,
    ...toolContractMetadata("inspect_wasm_component", evidenceEffects),
    kind: "artifact-provider",
    description:
      "Decode an explicit local WebAssembly component (component-model binary version 0xd, layer 1) in process. Returns the file SHA-256, section ranges, typed imports and exports with name attributes, type definitions, embedded core modules (range, SHA-256, import/export names), instances, aliases and canonical definitions inline as Evidence. Canonical lifts are traced to the core exports they wrap, and lowers to their imports and the core imports they are bound to. Reports per-section coverage and the gated features observed; sections it cannot decode are listed and later indices in affected sorts become null. Structural decoding only: it never validates, instantiates or executes the component or its modules and needs no WABT or other tools. Core modules (layer 0) use inspect_wasm_artifact. Files are bounded to 8 MiB.",
    inputSchema: inspectWasmComponentInputSchema,
    outputSchema: evidenceResultOf(wasmComponentSchema),
    examples: [
      {
        title: "Decode a selected local component",
        input: { path: "/artifacts/component.wasm" },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
