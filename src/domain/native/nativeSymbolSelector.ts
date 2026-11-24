import type { z } from "zod";
import type { addressedValueSchema } from "./nativeInventory.js";
import { compareUnicodeCodePoints } from "../unicodeCodePointOrder.js";

type NameRow = z.infer<typeof addressedValueSchema>;

/**
 * How a name selector matched the provider's name inventory:
 * - `exact_name`: an observed name equals the selector.
 * - `import_name`: the provider reports an external (imported) symbol whose
 *   library-qualified name, such as `KERNEL32.DLL::VirtualAlloc`, has the
 *   selector as its imported name, or the selector's library qualifier
 *   equals the reported one.
 */
export type NativeSymbolMatch = "exact_name" | "import_name";

export interface NativeSymbolCandidate {
  readonly address: string;
  readonly name: string;
}

export type NativeSymbolSelection =
  | {
      readonly status: "resolved";
      readonly address: string;
      readonly name: string;
      readonly match: NativeSymbolMatch;
    }
  | {
      readonly status: "ambiguous";
      readonly match: NativeSymbolMatch;
      readonly candidates: readonly NativeSymbolCandidate[];
    }
  | {
      readonly status: "unresolved";
      /**
       * Observed names equal to the imported name of a library-qualified
       * selector whose library the provider does not report. The library
       * association is unknown, so none is selected.
       */
      readonly candidates: readonly NativeSymbolCandidate[];
    };

const QUALIFIER = "::";

/** Split `LIBRARY::name` at its first separator; C++ names may contain more. */
const libraryQualified = (
  value: string,
): { readonly library: string; readonly name: string } | undefined => {
  const index = value.indexOf(QUALIFIER);
  return index <= 0 || index + QUALIFIER.length >= value.length
    ? undefined
    : {
        library: value.slice(0, index),
        name: value.slice(index + QUALIFIER.length),
      };
};

const select = (
  matches: readonly NameRow[],
  match: NativeSymbolMatch,
): NativeSymbolSelection | undefined => {
  const byAddress = new Map<string, string>();
  for (const row of matches)
    if (!byAddress.has(row.address)) byAddress.set(row.address, row.value);
  if (byAddress.size === 0) return undefined;
  const candidates = [...byAddress]
    .map(([address, name]) => ({ address, name }))
    .sort((left, right) =>
      compareUnicodeCodePoints(left.address, right.address),
    );
  return candidates.length === 1
    ? { status: "resolved", ...candidates[0]!, match }
    : { status: "ambiguous", match, candidates };
};

/**
 * Resolve one name selector against a provider's parsed name inventory. Every
 * name-taking native operation uses this owner, so one selector means the same
 * symbol in each. Import equivalence relies on the provider's `external`
 * symbol fact, never on name patterns: a provider that reports imports without
 * their library leaves a library-qualified selector unresolved, with the
 * same-named rows as candidates.
 */
export const selectNativeSymbol = (
  rows: readonly NameRow[],
  selector: string,
): NativeSymbolSelection => {
  const exact = select(
    rows.filter((row) => row.value === selector),
    "exact_name",
  );
  if (exact !== undefined) return exact;
  const qualified = libraryQualified(selector);
  const imported = select(
    rows.filter((row) => {
      if (row.symbol?.external !== true) return false;
      const reported = libraryQualified(row.value);
      if (reported === undefined) return false;
      return qualified === undefined
        ? reported.name === selector
        : reported.name === qualified.name &&
            reported.library.toUpperCase() === qualified.library.toUpperCase();
    }),
    "import_name",
  );
  if (imported !== undefined) return imported;
  if (qualified === undefined) return { status: "unresolved", candidates: [] };
  const candidates = new Map<string, string>();
  for (const row of rows)
    if (row.value === qualified.name && !candidates.has(row.address))
      candidates.set(row.address, row.value);
  return {
    status: "unresolved",
    candidates: [...candidates]
      .map(([address, name]) => ({ address, name }))
      .sort((left, right) =>
        compareUnicodeCodePoints(left.address, right.address),
      ),
  };
};
