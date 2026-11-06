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
    detail: analysisDetailSchema,
  },
);

/** Target-free EVM capabilities are independent of archive/Apple artifact providers. */
export const INSPECT_EVM_INTERFACE_CONTRACT = {
  name: "inspect_evm_interface",
  ...toolContractMetadata("inspect_evm_interface"),
  kind: "artifact-provider",
  requiresActiveTarget: true,
  description:
    'Inspect explicit local flat EVM bytecode without target execution or chain/RPC access. Select raw or hex encoding explicitly, or encoding {kind: solc-json, source_unit, contract_name, bytecode_kind: creation|deployed} to inspect an exact recorded compiler artifact. Preserve compiler diagnostics, JSON coordinates, metadata and unresolved reference spans. Only concrete selected bytes enter inference; unlinked or absent objects report inference_status unavailable with null decoded hex/digest. Source-unit keys are exact compiler identities; no basename fallback or compiler execution. Omitted or complete detail returns original carrier and decoded identities, full bytecode and all inferred interface candidates inline. For all inferred selectors/offsets/arguments/mutability and identities without bytecode hex or duplicated stdout, select detail: "summary" on this first call: it retains unchanged complete Evidence and returns a distinct linked inspect_analysis_view summary. Read original function rows or bytecode_hex/stdout/stderr text pages using view kind evm and normalized_result.parent_evidence_id; original complete Evidence remains accessible. Raw/hex bytecode kind stays unknown; solc-json kind is recorded compiler evidence. Hardfork, deployed authenticity and discovery completeness stay unknown; summary coverage covers only producer-returned candidates. Unchanged bundled EVMole 0.9.3/WASM in an owned bounded worker is initially real-verified on Linux x64; EOF-style EF00 containers are unsupported. Adjust timeout_ms (default 30000 ms, integer 1..2147483647) for the owned worker command on the next call; omitted timeout_ms keeps 30000 ms. Fixed byte, address-space, and CPU allowances stay unchanged. No signature lookup, wallet action or transaction broadcast.',
  inputSchema: evmInterfaceInspectionInputSchema,
  outputSchema: analysisDetailOutputSchemaOf(
    evmInterfaceSchema,
    evmInterfaceSummaryViewResultSchema,
  ),
  examples: [
    {
      title: "Select deployed bytecode from a recorded solc output",
      input: {
        path: "/artifacts/solc-output.json",
        encoding: {
          kind: "solc-json",
          source_unit: "src/Contract.sol",
          contract_name: "Contract",
          bytecode_kind: "deployed",
        },
      },
    },
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
