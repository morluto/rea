import {
  evmProxySchema,
  inspectEvmProxyInputSchema,
} from "../../domain/evm/evmProxy.js";
import { evidenceResultOf } from "../toolOutputSchemaPrimitives.js";
import type { ToolContract } from "../toolContractTypes.js";
import { evidenceEffects, toolContractMetadata } from "../toolEffects.js";

/** Pure offline recognition, available without the EVMole engine's host profile. */
export const INSPECT_EVM_PROXY_CONTRACT = {
  name: "inspect_evm_proxy",
  availability: "standalone",
  cli: true,
  ...toolContractMetadata("inspect_evm_proxy", evidenceEffects),
  kind: "artifact-provider",
  description:
    "Recognize the standard ERC-1167 minimal proxy clone in explicit local EVM runtime bytecode (raw or hex) and report the embedded implementation address with its decoded-byte range. Offline: no engine, execution, chain/RPC access or address lookup. Shortened-address clones, ERC-1967 slots and other proxy patterns are not inspected, so none_recognized does not show the code is not a proxy.",
  inputSchema: inspectEvmProxyInputSchema,
  outputSchema: evidenceResultOf(evmProxySchema),
  examples: [
    {
      title: "Read the target of a local clone proxy",
      input: { path: "/artifacts/runtime.hex", encoding: "hex" },
    },
  ],
} as const satisfies ToolContract;

export const EVM_PROXY_TOOL_CONTRACTS = [
  INSPECT_EVM_PROXY_CONTRACT,
] as const satisfies readonly ToolContract[];
