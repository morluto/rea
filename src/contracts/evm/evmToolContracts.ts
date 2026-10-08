import {
  inspectEvmInterfaceInputSchema,
  evmInterfaceSchema,
} from "../../domain/evm/evmInterface.js";
import type { ToolContract } from "../toolContractTypes.js";
import { toolContractMetadata } from "../toolEffects.js";
import { evidenceResultOf } from "../toolOutputSchemas.js";

/** Target-free EVM capabilities are independent of archive/Apple artifact providers. */
export const EVM_TOOL_CONTRACTS = [
  {
    name: "inspect_evm_interface",
    ...toolContractMetadata("inspect_evm_interface"),
    kind: "artifact-provider",
    description:
      "Inspect an explicit local flat EVM bytecode carrier and infer dispatch selectors, argument strings and mutability without executing the target or accessing a chain/RPC endpoint. Choose raw or hex encoding explicitly. Returns original carrier and decoded-byte SHA-256, full bytecode and interface candidates inline as inferred Evidence; bytecode kind, hardfork, deployed authenticity and discovery completeness remain unknown. Initial real-verified Linux x64 profile uses unchanged bundled EVMole 0.9.3/WASM in a bounded owned worker; EOF-style EF00 containers are unsupported. No signature lookup, wallet action or transaction broadcast.",
    inputSchema: inspectEvmInterfaceInputSchema,
    outputSchema: evidenceResultOf(evmInterfaceSchema),
    examples: [
      {
        title: "Inspect a local runtime bytecode hex carrier",
        input: { path: "/artifacts/runtime.hex", encoding: "hex" },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
