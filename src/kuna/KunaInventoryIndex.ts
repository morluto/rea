import { appendToMapList } from "../domain/appendToMapList.js";
import { z } from "zod";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { AnalysisInputError } from "../domain/analysisErrorCore.js";
import type { BinaryArchitecture } from "../domain/binaryTargetTypes.js";
import { err, ok, type Result } from "../domain/result.js";
import { normalizeKunaAddress } from "./KunaAddress.js";
import {
  kunaDataEntriesMessage,
  kunaDataEntriesRemediation,
  kunaDataEntryMessage,
  kunaDataEntryRemediation,
  kunaEntryLimitations,
  kunaExecutableInstructionRegion,
  placeKunaEntry,
  placeKunaInventory,
  type KunaDataPlacement,
  type KunaInventoryLayout,
  type KunaSelectedPlacement,
} from "./KunaInventoryPlacement.js";
import type { KunaInventoryFunction } from "./KunaProjectFiles.js";
import {
  ambiguousKunaNameMessage,
  KUNA_PROCEDURE_MISSING_ADDRESS_REMEDIATION,
  KUNA_PROCEDURE_MISSING_NAME_REMEDIATION,
  KUNA_XREF_MISSING_NAME_REMEDIATION,
  missingKunaXrefNameMessage,
} from "./KunaSelectorGuidance.js";

/**
 * Lookups over one inventory as the target's layout classifies it. Every
 * entry stays addressable for names and references; procedure operations
 * refuse the entries the layout places in data.
 */
export interface KunaInventoryIndex {
  readonly inventory: readonly KunaInventoryFunction[];
  readonly layout: KunaInventoryLayout;
  /** The data placement of each entry the layout places in data. */
  readonly data: ReadonlyMap<KunaInventoryFunction, KunaDataPlacement>;
  readonly unplaced: ReadonlySet<KunaInventoryFunction>;
  readonly byAddress: ReadonlyMap<string, KunaInventoryFunction>;
  readonly byName: ReadonlyMap<string, readonly KunaInventoryFunction[]>;
}

/**
 * One inventory entry a procedure request selected, with its placement and
 * the classification caveats every answer about it carries.
 */
export interface KunaResolvedEntry {
  readonly entry: KunaInventoryFunction;
  readonly placement: KunaSelectedPlacement;
  readonly limitations: readonly string[];
}

const procedureSelectorSchema = z.string().min(1);

const indexInventoryEntryNames = (
  byName: Map<string, KunaInventoryFunction[]>,
  entry: KunaInventoryFunction,
): void => {
  appendToMapList(byName, entry.name, entry);
  const { aliases } = entry;
  if (aliases.length === 0) return;
  if (aliases.length === 1) {
    const alias = aliases[0]!;
    if (alias !== entry.name) appendToMapList(byName, alias, entry);
    return;
  }
  if (aliases.length <= 8) {
    for (let i = 0; i < aliases.length; i += 1) {
      const alias = aliases[i]!;
      if (alias === entry.name) continue;
      let duplicate = false;
      for (let j = 0; j < i; j += 1) {
        if (aliases[j] === alias) {
          duplicate = true;
          break;
        }
      }
      if (!duplicate) appendToMapList(byName, alias, entry);
    }
    return;
  }
  const seen = new Set<string>([entry.name]);
  for (let i = 0; i < aliases.length; i += 1) {
    const alias = aliases[i]!;
    if (!seen.has(alias)) {
      seen.add(alias);
      appendToMapList(byName, alias, entry);
    }
  }
};

/** Build address and name lookups over one classified inventory. */
export const buildKunaInventoryIndex = (
  inventory: readonly KunaInventoryFunction[],
  layout: KunaInventoryLayout,
): KunaInventoryIndex => {
  const { data, unplaced } = placeKunaInventory(inventory, layout);
  const byAddress = new Map<string, KunaInventoryFunction>();
  const byName = new Map<string, KunaInventoryFunction[]>();
  for (const entry of inventory) {
    byAddress.set(entry.address, entry);
    indexInventoryEntryNames(byName, entry);
  }
  return {
    inventory,
    layout,
    data,
    unplaced,
    byAddress,
    byName,
  };
};

/** Whether the layout places the inventory entry at an address in data. */
export const isKunaDataAddress = (
  index: KunaInventoryIndex,
  address: string,
): boolean => {
  const entry = index.byAddress.get(address);
  return entry !== undefined && index.data.has(entry);
};

/**
 * Resolve an exact inventory name, alias or entry address. A procedure
 * selector excludes entries the layout places in data and returns the
 * caveats its placement leaves open; an address selector accepts every
 * entry and claims no procedure.
 */
export const resolveKunaInventoryEntry = (
  operation: string,
  raw: unknown,
  index: KunaInventoryIndex,
  targetArchitecture: BinaryArchitecture | undefined,
  field: "procedure" | "address" = "procedure",
): Result<KunaResolvedEntry, AnalysisError> => {
  const parsed = procedureSelectorSchema.safeParse(raw);
  if (!parsed.success)
    return err(
      new AnalysisInputError(
        operation,
        { userMessage: `${field} is required.` },
        [{ path: [field], reason: "missing_argument" }],
      ),
    );
  const selector = parsed.data;
  const address = normalizeKunaAddress(selector);
  const refused = (entry: KunaInventoryFunction) =>
    field === "procedure" && index.data.has(entry);
  const dataRefusal = (entry: KunaInventoryFunction) => {
    const placement = index.data.get(entry)!;
    return err(
      new AnalysisInputError(operation, {
        userMessage: kunaDataEntryMessage(entry, placement),
        conformsToInputContract: true,
        remediationAction: kunaDataEntryRemediation(placement),
      }),
    );
  };
  const selected = (entry: KunaInventoryFunction) => {
    const placement = placeKunaEntry(index.layout, entry);
    return ok({
      entry,
      placement,
      limitations:
        field === "procedure"
          ? kunaEntryLimitations(index.layout, placement)
          : [],
    });
  };
  if (address !== undefined) {
    const entry = index.byAddress.get(address);
    if (entry === undefined)
      return err(
        new AnalysisInputError(
          operation,
          {
            userMessage: `${address} is not a procedure entry Kuna found; list_procedures shows the entries it found.`,
            remediationAction:
              operation === "procedure_pseudo_code" &&
              targetArchitecture === "arm64" &&
              kunaExecutableInstructionRegion(index.layout, address) !==
                undefined
                ? "Use xrefs for the exact address. If Kuna reports a direct call from a discovered procedure, retry procedure_pseudo_code with analysis: call_destination."
                : KUNA_PROCEDURE_MISSING_ADDRESS_REMEDIATION,
            conformsToInputContract: true,
          },
          [
            {
              path: [field],
              reason: "invalid_value",
              message:
                "The address was not found in Kuna's procedure inventory.",
              observed: { [field]: selector },
            },
          ],
        ),
      );
    return refused(entry) ? dataRefusal(entry) : selected(entry);
  }
  const named = index.byName.get(selector) ?? [];
  const matches = named.filter((entry) => !refused(entry));
  if (matches.length === 1 && matches[0] !== undefined)
    return selected(matches[0]);
  if (matches.length === 0 && named.length === 1 && named[0] !== undefined)
    return dataRefusal(named[0]);
  const missing = named.length === 0;
  const ambiguous = matches.length > 1;
  // Read only when every named entry was refused, so each has a data placement.
  const dataEntries = () =>
    named.map((entry) => ({ entry, placement: index.data.get(entry)! }));
  const procedureLookupFailure =
    field === "procedure" && (missing || ambiguous);
  const message = missing
    ? field === "address"
      ? missingKunaXrefNameMessage(selector)
      : `Kuna found no procedure named ${selector}; search_procedures finds similar names.`
    : matches.length === 0
      ? kunaDataEntriesMessage(selector, dataEntries())
      : ambiguousKunaNameMessage(
          selector,
          matches.map(({ address }) => address),
        );
  // An ambiguous name is a typed selector refusal; its recovery is derived.
  const remediationAction = ambiguous
    ? undefined
    : field === "address"
      ? missing
        ? KUNA_XREF_MISSING_NAME_REMEDIATION
        : "Select one of the reported addresses and call xrefs again."
      : procedureLookupFailure
        ? KUNA_PROCEDURE_MISSING_NAME_REMEDIATION
        : matches.length === 0
          ? kunaDataEntriesRemediation(
              dataEntries().map(({ placement }) => placement),
            )
          : undefined;
  return err(
    new AnalysisInputError(
      operation,
      {
        userMessage: message,
        ...(remediationAction === undefined
          ? {}
          : { remediationAction, conformsToInputContract: true }),
        ...(ambiguous
          ? {
              ambiguousSelector: {
                field: [field],
                candidates: matches.map(({ address }) => address),
              },
            }
          : {}),
      },
      procedureLookupFailure
        ? [
            {
              path: [field],
              reason: "invalid_value",
              message: "The selector did not identify one procedure entry.",
              observed: { procedure: selector },
            },
          ]
        : undefined,
    ),
  );
};
