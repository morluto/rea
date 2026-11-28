import {
  solidityMetadataVerificationSchema,
  verifySolidityMetadataInputSchema,
} from "../../domain/evm/solidityMetadataBinding.js";
import { evidenceResultOf } from "../toolOutputSchemaPrimitives.js";
import type { ToolContract } from "../toolContractTypes.js";
import { evidenceEffects, toolContractMetadata } from "../toolEffects.js";

/** Pure offline comparison, available without the EVMole engine's host profile. */
export const VERIFY_SOLIDITY_METADATA_CONTRACT = {
  name: "verify_solidity_metadata",
  availability: "standalone",
  cli: true,
  ...toolContractMetadata("verify_solidity_metadata", evidenceEffects),
  kind: "artifact-provider",
  description:
    "Check whether a caller-selected local metadata JSON file is the one committed to by the CBOR trailer of local EVM bytecode (raw or hex). Compares the exact file bytes with an IPFS commitment: match, mismatch or unverified with a reason (no decoded trailer, no or several commitments, Swarm or unrecognized scheme, file too large to hash). Offline: no engine, execution, IPFS/Swarm or source retrieval. A match does not verify source, compilation or deployment.",
  inputSchema: verifySolidityMetadataInputSchema,
  outputSchema: evidenceResultOf(solidityMetadataVerificationSchema),
  examples: [
    {
      title: "Verify a compiler metadata file against runtime bytecode",
      input: {
        path: "/artifacts/runtime.hex",
        encoding: "hex",
        metadata_path: "/artifacts/metadata.json",
      },
    },
  ],
} as const satisfies ToolContract;

export const SOLIDITY_METADATA_TOOL_CONTRACTS = [
  VERIFY_SOLIDITY_METADATA_CONTRACT,
] as const satisfies readonly ToolContract[];
