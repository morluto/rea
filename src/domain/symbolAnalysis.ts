import type { JsonValue } from "./jsonValue.js";
import type { AddressedName } from "./hopperValues.js";

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
      ({ name }) => name.includes("OBJC_PROTOCOL") || name.includes("_TtP"),
    ),
  );
  return {
    count: protocols.length,
    protocols: protocols.map(toJsonEntry),
  };
};

const SWIFT_CATEGORIES = [
  ["classes", "_TtC"],
  ["structs", "_TtV"],
  ["enums", "_TtO"],
  ["protocols", "_TtP"],
  ["extensions", "_TtE"],
] as const;
type SwiftTypeCategory = (typeof SWIFT_CATEGORIES)[number][0] | "other";

/**
 * Procedure names the classifier treats as Swift symbols: modern Swift 4.2+
 * manglings (`$s`, spelled `_$s` at Mach-O boundaries) and the legacy `_Tt`
 * manglings. The category prefixes above only describe legacy `_Tt`
 * families, so modern manglings are counted under `other` rather than being
 * silently dropped from the inventory. Mirrors the Swift-symbol recognition
 * used by the native metadata classifier (`objcSwiftMetadata.ts`).
 */
const isSwiftSymbolName = (name: string): boolean =>
  /^(?:_?\$s)/u.test(name) || name.includes("_Tt");

/** Categorize deduplicated Swift mangled symbols. */
export const categorizeSwiftTypes = (
  procedures: readonly AddressedName[],
  filter: {
    readonly category?: SwiftTypeCategory | undefined;
    readonly pattern?: string | undefined;
  } = {},
): JsonValue => {
  const groups: Record<string, AddressedName[]> = Object.fromEntries(
    [...SWIFT_CATEGORIES.map(([category]) => category), "other"].map(
      (category) => [category, []],
    ),
  );
  const seen = new Set<string>();

  for (const entry of procedures) {
    if (!isSwiftSymbolName(entry.name) || seen.has(entry.name)) continue;
    const category =
      SWIFT_CATEGORIES.find(([, prefix]) =>
        entry.name.startsWith(prefix),
      )?.[0] ?? "other";
    if (filter.category !== undefined && filter.category !== category) continue;
    if (filter.pattern !== undefined && !entry.name.includes(filter.pattern))
      continue;
    seen.add(entry.name);
    groups[category]?.push(entry);
  }

  const categories = Object.fromEntries(
    Object.entries(groups).map(([category, items]) => [
      category,
      { count: items.length, items: items.map(toJsonEntry) },
    ]),
  );
  return { total: seen.size, categories };
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
