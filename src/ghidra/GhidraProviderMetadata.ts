import type { ProviderIdentity } from "../application/AnalysisProvider.js";
import { GHIDRA_FUNCTION_OPERATIONS } from "./GhidraFunctionOperations.js";
import { GHIDRA_INVENTORY_OPERATIONS } from "./GhidraInventoryOperations.js";

/** Public identity committed by every Ghidra-backed observation. */
export const GHIDRA_PROVIDER_IDENTITY: ProviderIdentity = Object.freeze({
  id: "ghidra",
  name: "Ghidra",
  version: null,
});

/** Public analyst tools backed by these observations; aggregates stay internal. */
export const GHIDRA_OPERATIONS = Object.freeze(
  [...GHIDRA_INVENTORY_OPERATIONS, ...GHIDRA_FUNCTION_OPERATIONS].map(
    (operation) =>
      operation === "read_binary_inventory_summary"
        ? "binary_overview"
        : operation,
  ),
);
