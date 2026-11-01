/** Recovery for an xref name absent from Kuna's own inventory. */
export const KUNA_XREF_MISSING_NAME_REMEDIATION =
  "Inspect target symbols or exports where available, verify address coordinates, and call xrefs with an address. Absence from Kuna's inventory does not establish absence from the target.";

/** Recovery for a name with multiple observed inventory entries. */
export const KUNA_XREF_AMBIGUOUS_NAME_REMEDIATION =
  "Select one of the reported addresses and call xrefs again.";

export const KUNA_PROCEDURE_MISSING_NAME_REMEDIATION =
  "Use search_procedures or list_procedures to inspect Kuna's current inventory. An absent name does not establish that the function is absent from the target.";

export const KUNA_PROCEDURE_AMBIGUOUS_NAME_REMEDIATION =
  "Select one of the reported procedure addresses and retry the operation.";

export const missingKunaXrefNameMessage = (selector: string): string =>
  `Kuna's inventory has no entry named ${selector}.`;

export const ambiguousKunaNameMessage = (
  selector: string,
  addresses: readonly string[],
): string =>
  `${selector} names ${String(addresses.length)} Kuna entries (${addresses.join(", ")}); select one by address.`;
