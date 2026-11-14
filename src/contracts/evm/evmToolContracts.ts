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
import { evmInterfaceSummaryViewResultSchema } from "../../domain/analysisView/analysisViewResult.js";

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
    "Infer interface candidates from explicit local flat EVM bytecode using bundled EVMole 0.9.3/WASM; select raw or hex encoding. Linux x64 profile; EOF-style EF00 containers are unsupported. Returns selectors, offsets, arguments and mutability candidates, not verified deployment or runtime behavior. Bytecode kind, hardfork and discovery completeness stay unknown. Default complete includes bytecode/full Evidence; detail summary retains it for inspect_analysis_view kind evm, facets functions/bytecode_hex/stdout/stderr, via parent_evidence_id. timeout_ms and producer_limits are independent of each other and worker heap; tighter inherited limits still apply. No target execution, chain/RPC access, signature lookup, wallet action or broadcast.",
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
