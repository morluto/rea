import { FUNCTION_COMPARISON_EXAMPLE } from "../../src/contracts/functionComparisonExample.js";
import { functionDossierSchema } from "../../src/domain/native/functionDossier.js";

/** Synthetic connected CFG whose two possible entry blocks have different degrees. */
export const functionCfgDossier = (base = 0x1000n, entryOffset = 0n) => {
  const address = (offset: bigint) => `0x${(base + offset).toString(16)}`;
  const value = functionDossierSchema.parse(
    FUNCTION_COMPARISON_EXAMPLE.left.normalized_result,
  );
  value.procedure.address = address(entryOffset);
  value.basic_blocks = [
    { start: address(0n), end: address(1n), successors: [address(0x10n)] },
    {
      start: address(0x10n),
      end: address(0x12n),
      successors: [address(0n), address(0x20n)],
    },
    { start: address(0x20n), end: address(0x23n), successors: [] },
  ];
  value.unresolved_calls = [];
  return value;
};
