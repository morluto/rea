import type { JsonValue } from "../jsonValue.js";

/** Source element types needed to distinguish large integers from integral reals. */
export interface PlistNumberLiterals {
  readonly integers: ReadonlyMap<number, ReadonlySet<string>>;
  readonly reals: ReadonlySet<number>;
  /** Integer literals in the original serialized plist, not decoded graph slots. */
  readonly unsafeIntegerLiterals: number;
  /** Supplemental byte metadata was not completely observable. */
  readonly incomplete: boolean;
}

/** Preserve unambiguous exact integers; disclose rounded or unclassified numbers. */
export const createPlistNumberProjection = (literals: PlistNumberLiterals) => {
  let exactIntegerCount = 0;
  let ambiguousNumberCount = 0;
  const mapNumber = (item: number): JsonValue => {
    if (Number.isSafeInteger(item) || !Number.isInteger(item)) return item;
    if (literals.incomplete) {
      ambiguousNumberCount += 1;
      return item;
    }
    const decimals = literals.integers.get(item);
    if (decimals === undefined) {
      if (!literals.reals.has(item)) ambiguousNumberCount += 1;
      return item;
    }
    const [decimal] = decimals;
    if (
      decimals.size !== 1 ||
      decimal === undefined ||
      literals.reals.has(item)
    ) {
      ambiguousNumberCount += 1;
      return item;
    }
    exactIntegerCount += 1;
    return { $plist_type: "integer", decimal };
  };
  const map = (item: JsonValue): JsonValue => {
    if (typeof item === "number") return mapNumber(item);
    if (Array.isArray(item)) return item.map(map);
    if (item !== null && typeof item === "object") {
      const keys = Object.keys(item);
      const marker = item[keys[0] ?? ""];
      const reference =
        keys.length === 1 &&
        (keys[0] === "UID" || keys[0] === "CF$UID") &&
        typeof marker === "number";
      if (reference) {
        // Keep malformed numeric reference markers recognizable by the graph reader.
        if (
          typeof marker === "number" &&
          !Number.isSafeInteger(marker) &&
          (literals.integers.has(marker) || !literals.reals.has(marker))
        )
          ambiguousNumberCount += 1;
        return item;
      }
      return Object.fromEntries(
        Object.entries(item).map(([key, child]) => [key, map(child)]),
      );
    }
    return item;
  };
  return {
    project: map,
    limitations: () => [
      ...(literals.incomplete
        ? [
            "Original archive number metadata could not be completely observed; decoded numbers may lose integer precision and exact integer/real association is unavailable.",
          ]
        : []),
      ...(literals.unsafeIntegerLiterals === 0
        ? []
        : [
            `${String(literals.unsafeIntegerLiterals)} observed integer literal(s) in the original archive exceed the exact range of a JSON number. Decoded numbers may lose integer precision unless represented as { "$plist_type": "integer", "decimal": "<exact digits>" }; the original archive bytes retain those literals.`,
          ]),
      ...(exactIntegerCount === 0
        ? []
        : [
            `${String(exactIntegerCount)} unambiguous integer value(s) are reported with exact decimal text as { "$plist_type": "integer", "decimal": "<exact digits>" }.`,
          ]),
      ...(ambiguousNumberCount === 0
        ? []
        : [
            `${String(ambiguousNumberCount)} number(s) beyond the exact integer range remain as decoded because their source integer/real type or reference marker cannot be associated unambiguously; integer precision loss remains possible.`,
          ]),
    ],
  };
};
