import {
  inspectEvmInterfaceInputSchema,
  evmInterfaceSchema,
} from "../../domain/evm/evmInterface.js";
import type { ToolContract } from "../toolContractTypes.js";
import { toolContractMetadata } from "../toolEffects.js";
import {
  analysisDetailSchema,
  analysisDetailOutputSchemaOf,
} from "../analysisDetail.js";
import { evmInterfaceSummaryViewResultSchema } from "../../domain/analysisView/analysisView.js";

/** Delivery selection leaves the existing provider input and original Evidence unchanged. */
const evmInterfaceInspectionInputSchema = inspectEvmInterfaceInputSchema.extend(
  {
    detail: analysisDetailSchema.unwrap().optional(),
  },
);

/** Target-free EVM capabilities are independent of archive/Apple artifact providers. */
export const INSPECT_EVM_INTERFACE_CONTRACT = {
  name: "inspect_evm_interface",
  ...toolContractMetadata("inspect_evm_interface"),
  kind: "artifact-provider",
  description:
    'Inspect explicit local flat EVM bytecode without target execution or chain/RPC access. Select raw or hex encoding explicitly. Omitted or complete detail returns original carrier and decoded identities, full bytecode and all inferred interface candidates inline. For all inferred selectors/offsets/arguments/mutability and identities without bytecode hex or duplicated stdout, select detail: "summary" on this first call: it retains unchanged complete Evidence and returns a distinct linked inspect_analysis_view summary. Read original function rows or bytecode_hex/stdout/stderr text pages using view kind evm and normalized_result.parent_evidence_id; original complete Evidence remains accessible. Bytecode kind, hardfork, deployed authenticity and discovery completeness stay unknown; summary coverage covers only producer-returned candidates. Unchanged bundled EVMole 0.9.3/WASM in an owned bounded worker is initially real-verified on Linux x64; EOF-style EF00 containers are unsupported. No signature lookup, wallet action or transaction broadcast.',
  inputSchema: evmInterfaceInspectionInputSchema,
  outputSchema: analysisDetailOutputSchemaOf(
    evmInterfaceSchema,
    evmInterfaceSummaryViewResultSchema,
  ),
  examples: [
    {
      title: "Inspect a local runtime bytecode hex carrier",
      input: { path: "/artifacts/runtime.hex", encoding: "hex" },
    },
    {
      title: "Read every inferred interface candidate without bytecode text",
      input: {
        path: "/artifacts/runtime.hex",
        encoding: "hex",
        detail: "summary",
      },
    },
  ],
} as const satisfies ToolContract;

/** Preserve the default catalog's exact operation and ordering. */
export const EVM_TOOL_CONTRACTS = [
  INSPECT_EVM_INTERFACE_CONTRACT,
] as const satisfies readonly ToolContract[];
