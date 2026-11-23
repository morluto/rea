import { objcClassSymbol, objcSymbolLeaf } from "./objcClassSymbol.js";
import type { JsonValue } from "./jsonValue.js";
import type { AddressedName } from "./native/nativeInventory.js";
import type {
  MachoImportBinding,
  ObjcClassDiscoveryCoverage,
} from "./native/objcSwiftMetadata.js";
import {
  classifySwiftSymbol,
  isSwiftSymbolName,
  type SwiftTypeCategory,
} from "./swiftSymbolClassification.js";

/** Local class records emitted by Apple's fragile Objective-C ABI. */
const LEGACY_OBJC_CLASS_PREFIX = "l_OBJC_CLASS_" as const;

/** Objective-C protocol declaration labels with their object-file prefixes. */
const OBJC_PROTOCOL_SYMBOL = /^_{0,2}OBJC_PROTOCOL_\$_[^\s]+$/u;

export interface ObjcClassImportBindingScan {
  readonly bindings: readonly MachoImportBinding[];
  readonly coverage: ObjcClassDiscoveryCoverage;
}

/** Select class labels and apply the caller's literal filter before identity joins. */
export const selectObjcClassCandidates = (
  names: readonly AddressedName[],
  pattern: string,
): AddressedName[] => {
  const seen = new Set<string>();
  return names.filter(({ address, name, objc_class_label }) => {
    if (pattern.length > 0 && !name.includes(pattern)) return false;
    const classLabel =
      objcClassSymbol(name)?.metaclass === false ||
      objc_class_label === "hopper_legacy_class_object" ||
      (name.startsWith(LEGACY_OBJC_CLASS_PREFIX) &&
        name.length > LEGACY_OBJC_CLASS_PREFIX.length &&
        !/^l_OBJC_CLASS_NAME_(?:\.\d+)?$/u.test(name));
    if (!classLabel) return false;
    // Keep equal labels at distinct addresses until their slot identity is known.
    const key = JSON.stringify([address, name]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

/** Project selected class labels, coalescing only exact proven import identities. */
export const projectObjcClassCandidates = (
  candidates: readonly AddressedName[],
  bindingScan: ObjcClassImportBindingScan,
): JsonValue => {
  const classes = coalesceBoundClassAliases(candidates, bindingScan.bindings);
  return {
    count: classes.length,
    classes,
    identity_coverage: {
      status: bindingScan.coverage.status,
      reason: bindingScan.coverage.reason,
    },
  };
};

/** Select and deduplicate Objective-C and Swift protocol labels. */
export const discoverObjcProtocols = (
  names: readonly AddressedName[],
): JsonValue => {
  const protocols = uniqueByName(
    names.filter(
      ({ name }) =>
        OBJC_PROTOCOL_SYMBOL.test(objcSymbolLeaf(name)) ||
        classifySwiftSymbol(name)?.protocolIdentity === true,
    ),
  );
  return {
    count: protocols.length,
    protocols: protocols.map(toJsonEntry),
  };
};

/** Categorize procedure names using Swift manglings at their exact addresses. */
export const categorizeSwiftTypes = (
  procedures: readonly AddressedName[],
  filter: {
    readonly category?: SwiftTypeCategory | undefined;
    readonly pattern?: string | undefined;
  } = {},
  symbols: readonly AddressedName[] = [],
) => {
  const groups: Record<
    string,
    Array<{
      address: string;
      name: string;
      mangled_names: string[];
    }>
  > = Object.fromEntries(
    ["classes", "structs", "enums", "protocols", "extensions", "other"].map(
      (category) => [category, []],
    ),
  );
  const aliases = swiftAliasesByAddress(symbols);
  const pattern = filter.pattern;
  const seen = new Set<string>();
  const unclassifiedNames = new Set<string>();
  const unclassified: Array<{
    address: string;
    name: string;
    mangled_names: string[];
    reason: "category_not_decoded" | "conflicting_categories";
  }> = [];

  for (const entry of procedures) {
    if (seen.has(entry.name)) continue;
    const mangledNames = [
      ...new Set([
        ...(isSwiftSymbolName(entry.name) ? [entry.name] : []),
        ...(aliases.get(entry.address) ?? []),
      ]),
    ];
    if (mangledNames.length === 0) continue;
    if (
      pattern !== undefined &&
      ![entry.name, ...mangledNames].some((name) => name.includes(pattern))
    )
      continue;
    // Only decoded categories vote. A Swift-looking alias whose category is
    // not decoded remains evidence without erasing a decoded category.
    const kinds = new Set<SwiftTypeCategory>();
    for (const name of mangledNames) {
      const decoded = classifySwiftSymbol(name)?.category;
      if (decoded !== undefined && decoded !== null) kinds.add(decoded);
    }
    const category = kinds.size === 1 ? ([...kinds][0] ?? null) : null;
    const item = {
      address: entry.address,
      name: entry.name,
      mangled_names: mangledNames,
    };
    if (category === null && !unclassifiedNames.has(entry.name)) {
      unclassifiedNames.add(entry.name);
      unclassified.push({
        ...item,
        reason:
          kinds.size > 1 ? "conflicting_categories" : "category_not_decoded",
      });
    }
    const bucket = category ?? "other";
    if (filter.category === undefined || filter.category === bucket) {
      seen.add(entry.name);
      groups[bucket]?.push(item);
    }
  }

  const categories = Object.fromEntries(
    Object.entries(groups).map(([category, items]) => [
      category,
      { count: items.length, items },
    ]),
  );
  return {
    total: Object.values(groups).reduce((sum, items) => sum + items.length, 0),
    categories,
    unclassified,
    limitations: [
      "Identification uses Swift mangled procedure names or same-address symbol aliases. Demangled names without retained Swift manglings cannot be identified. Counts deduplicate procedure names, not source declarations.",
      ...(unclassified.length === 0
        ? []
        : [
            "Some Swift categories could not be established from the retained manglings. Unclassified observations remain inline regardless of the category filter.",
          ]),
    ],
  };
};

const swiftAliasesByAddress = (symbols: readonly AddressedName[]) => {
  const aliases = new Map<string, string[]>();
  for (const { address, name } of symbols) {
    if (!isSwiftSymbolName(name)) continue;
    const existing = aliases.get(address);
    if (existing === undefined) aliases.set(address, [name]);
    else existing.push(name);
  }
  return aliases;
};

const uniqueByName = (entries: readonly AddressedName[]): AddressedName[] => {
  const seen = new Set<string>();
  return entries.filter(({ name }) => {
    if (seen.has(name)) return false;
    seen.add(name);
    return true;
  });
};

interface ObjcClassBindingGroup {
  readonly identity: MachoImportBinding;
  readonly slotAddresses: Set<string>;
  readonly canonicalSymbol: string | undefined;
  representative: AddressedName | undefined;
  canonical: boolean;
}

const coalesceBoundClassAliases = (
  candidates: readonly AddressedName[],
  bindings: readonly MachoImportBinding[],
): JsonValue[] => {
  const groupByIdentity = new Map<string, ObjcClassBindingGroup>();
  const groupByAddress = new Map<string, ObjcClassBindingGroup>();
  for (const identity of bindings) {
    const key = JSON.stringify([
      identity.symbol,
      identity.binding_source,
      identity.library_ordinal,
      identity.library,
      identity.weak,
      identity.addend,
    ]);
    let group = groupByIdentity.get(key);
    if (group === undefined) {
      group = {
        identity,
        slotAddresses: new Set(),
        canonicalSymbol: classNameFromImport(identity.symbol),
        representative: undefined,
        canonical: false,
      };
      groupByIdentity.set(key, group);
    }
    group.slotAddresses.add(identity.requested_address);
    groupByAddress.set(identity.requested_address, group);
  }

  const ordered: Array<AddressedName | ObjcClassBindingGroup> = [];
  for (const candidate of candidates) {
    const group = groupByAddress.get(candidate.address);
    if (group === undefined) {
      ordered.push(candidate);
      continue;
    }
    if (group.representative === undefined) {
      group.representative = candidate;
      ordered.push(group);
    }
    if (
      !group.canonical &&
      group.canonicalSymbol !== undefined &&
      classNameFromImport(candidate.name) === group.canonicalSymbol
    ) {
      group.representative = candidate;
      group.canonical = true;
    }
  }

  return ordered.map((entry) => {
    if (!("identity" in entry)) return toJsonEntry(entry);
    const { identity, representative, slotAddresses } = entry;
    return {
      address: representative!.address,
      name: representative!.name,
      binding_identity: {
        symbol: identity.symbol,
        binding_source: identity.binding_source,
        library_ordinal: identity.library_ordinal,
        library: identity.library,
        weak: identity.weak,
        addend: identity.addend,
        slot_addresses: [...slotAddresses],
      },
    };
  });
};

const classNameFromImport = (symbol: string): string | undefined => {
  const facts = objcClassSymbol(symbol);
  return facts?.metaclass === false ? facts.symbol : undefined;
};

const toJsonEntry = ({ address, name }: AddressedName): JsonValue => ({
  address,
  name,
});
