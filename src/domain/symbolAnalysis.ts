import type { JsonValue } from "./jsonValue.js";
import type { AddressedName } from "./hopperValues.js";
import {
  classifySwiftSymbol,
  type SwiftTypeCategory,
} from "./swiftSymbolClassification.js";

/** Select and deduplicate Objective-C class labels. */
export const discoverObjcClasses = (
  names: readonly AddressedName[],
  pattern: string,
): JsonValue => {
  const classes = uniqueByName(
    names
      .filter(({ name }) =>
        ["OBJC_CLASS", "OBJC_$_CLASS"].some((marker) => name.includes(marker)),
      )
      .filter(({ name }) => pattern.length === 0 || name.includes(pattern)),
  );
  return {
    count: classes.length,
    classes: classes.map(toJsonEntry),
  };
};

/** Select and deduplicate Objective-C and Swift protocol labels. */
export const discoverObjcProtocols = (
  names: readonly AddressedName[],
): JsonValue => {
  const protocols = uniqueByName(
    names.filter(
      ({ name }) =>
        name.includes("OBJC_PROTOCOL") ||
        name.includes("_TtP") ||
        (name.endsWith("Mp") &&
          classifySwiftSymbol(name)?.category === "protocols"),
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
        ...(classifySwiftSymbol(entry.name) === undefined ? [] : [entry.name]),
        ...(aliases.get(entry.address) ?? []),
      ]),
    ];
    if (mangledNames.length === 0) continue;
    if (
      pattern !== undefined &&
      ![entry.name, ...mangledNames].some((name) => name.includes(pattern))
    )
      continue;
    const kinds = new Set(
      mangledNames.map((name) => classifySwiftSymbol(name)?.category ?? null),
    );
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
          kinds.size > 1 && !kinds.has(null)
            ? "conflicting_categories"
            : "category_not_decoded",
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
    if (classifySwiftSymbol(name) === undefined) continue;
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

const toJsonEntry = ({ address, name }: AddressedName): JsonValue => ({
  address,
  name,
});
