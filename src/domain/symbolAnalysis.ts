import type { JsonValue } from "../hopper/protocol.js";
import type { AddressedName } from "./hopperValues.js";

const MAX_SCANNED_SYMBOLS = 5_000;
const MAX_RETURNED_SYMBOLS = 100;

/** Select Swift class symbols using the legacy `_TtC` convention. */
export const discoverSwiftClasses = (
  procedures: readonly AddressedName[],
  pattern: string,
): JsonValue => {
  const classes = procedures
    .slice(0, MAX_SCANNED_SYMBOLS)
    .filter(({ name }) => name.includes("_TtC"))
    .filter(({ name }) => pattern.length === 0 || name.includes(pattern));
  return {
    count: classes.length,
    classes: classes.slice(0, MAX_RETURNED_SYMBOLS).map(toJsonEntry),
  };
};

/** Select and deduplicate Objective-C class labels. */
export const discoverObjcClasses = (
  names: readonly AddressedName[],
  pattern: string,
): JsonValue => {
  const classes = uniqueByName(
    names
      .filter(
        ({ name }) =>
          ["OBJC_CLASS", "OBJC_$_CLASS"].some((marker) =>
            name.includes(marker),
          ) || name.startsWith("_OBJC_"),
      )
      .filter(({ name }) => pattern.length === 0 || name.includes(pattern)),
  );
  return {
    count: classes.length,
    classes: classes.slice(0, MAX_RETURNED_SYMBOLS).map(toJsonEntry),
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
    protocols: protocols.slice(0, MAX_RETURNED_SYMBOLS).map(toJsonEntry),
  };
};

const SWIFT_CATEGORIES = [
  ["classes", "_TtC"],
  ["structs", "_TtV"],
  ["enums", "_TtO"],
  ["protocols", "_TtP"],
  ["extensions", "_TtE"],
] as const;

/** Categorize deduplicated Swift mangled symbols. */
export const categorizeSwiftTypes = (
  procedures: readonly AddressedName[],
): JsonValue => {
  const groups: Record<string, AddressedName[]> = Object.fromEntries(
    [...SWIFT_CATEGORIES.map(([category]) => category), "other"].map(
      (category) => [category, []],
    ),
  );
  const seen = new Set<string>();

  for (const entry of procedures.slice(0, MAX_SCANNED_SYMBOLS)) {
    if (!entry.name.includes("_Tt") || seen.has(entry.name)) continue;
    seen.add(entry.name);
    const category =
      SWIFT_CATEGORIES.find(([, prefix]) =>
        entry.name.startsWith(prefix),
      )?.[0] ?? "other";
    groups[category]?.push(entry);
  }

  const categories = Object.fromEntries(
    Object.entries(groups).map(([category, items]) => [
      category,
      { count: items.length, items: items.slice(0, 50).map(toJsonEntry) },
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
