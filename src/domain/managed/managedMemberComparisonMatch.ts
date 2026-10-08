import { createHash } from "node:crypto";

import canonicalize from "canonicalize";

import { parseEvidence } from "../evidence.js";
import {
  managedMemberInspectionSchema,
  type ManagedMemberInspection,
} from "./managedArtifact.js";
import type {
  ManagedMemberComparisonResult,
  ManagedMemberComparisonSide,
} from "./managedMemberComparison.js";
import type { JsonValue } from "../jsonValue.js";

export const sha256 = (value: JsonValue): string => {
  const serialized = canonicalize(value);
  if (serialized === undefined)
    throw new TypeError("Managed comparison canonicalization failed");
  return createHash("sha256").update(serialized).digest("hex");
};

type Method = ManagedMemberInspection["methods"][number];
type Field = ManagedMemberInspection["fields"][number];
type MatchBasis =
  ManagedMemberComparisonResult["methods"][number]["match"]["basis"];
type ConcreteMatchBasis = Exclude<MatchBasis, "none">;

interface Keyed<Item> {
  readonly item: Item;
  readonly exactKey: string | null;
  readonly signatureKey: string | null;
  readonly structuralKey: string | null;
}

interface MatchedPair<Item> {
  readonly left: Keyed<Item>;
  readonly right: Keyed<Item>;
  readonly basis: ConcreteMatchBasis;
  readonly confidence: "exact" | "high";
}

interface Ambiguous<Item> {
  readonly left: readonly Keyed<Item>[];
  readonly right: readonly Keyed<Item>[];
  readonly basis: ConcreteMatchBasis;
}

const keyMethod = (item: Method): Keyed<Method> => ({
  item,
  exactKey:
    item.body.status === "present" && item.body.normalized_il_sha256 !== null
      ? stableKey([
          "method-exact",
          item.signature.raw_sha256,
          item.body.normalized_il_sha256,
        ])
      : null,
  // The raw blob is the exact signature; decoding only feeds shape keys.
  signatureKey: stableKey([
    "method-signature",
    item.declaring_type,
    item.name,
    item.signature.raw_sha256,
  ]),
  structuralKey:
    item.signature.parse_status === "decoded" && item.body.status === "present"
      ? stableKey([
          "method-structural",
          item.signature.kind,
          item.signature.calling_convention,
          item.signature.generic_parameter_count,
          item.signature.parameter_count,
          item.signature.return_type,
          item.signature.parameter_types,
          item.body.status,
          item.body.header_format,
          item.body.il_size,
          item.body.max_stack,
          item.body.init_locals,
          item.body.opcode_counts,
          item.body.anchors.map(({ opcode, operand_kind }) => [
            opcode,
            operand_kind,
          ]),
          item.body.exception_regions.map((region) => [
            region.flags,
            region.try_length,
            region.handler_length,
            region.class_token === null ? null : "type-token",
            region.filter_offset === null ? null : "filter",
          ]),
        ])
      : null,
});

const keyField = (item: Field): Keyed<Field> => ({
  item,
  exactKey:
    item.signature.parse_status === "decoded"
      ? stableKey(["field-exact", item.signature.raw_sha256])
      : null,
  // Only an undecoded field reaches this round: a decoded field with the
  // same raw signature already met its counterpart in the exact round.
  signatureKey: stableKey([
    "field-signature",
    item.declaring_type,
    item.name,
    item.signature.raw_sha256,
  ]),
  structuralKey: stableKey([
    "field-structural",
    item.signature.kind,
    item.signature.field_type,
    item.flags,
  ]),
});

const stableKey = (value: JsonValue): string => sha256(value);

const matchMethods = (
  left: readonly Keyed<Method>[],
  right: readonly Keyed<Method>[],
) =>
  matchByKeys({
    left,
    right,
    exactBasis: "exact-il-signature",
    fallbackBases: [
      {
        basis: "exact-signature",
        key: ({ signatureKey }) => signatureKey,
      },
      {
        basis: "structural-method-shape",
        key: ({ structuralKey }) => structuralKey,
      },
    ],
  });

const matchFields = (
  left: readonly Keyed<Field>[],
  right: readonly Keyed<Field>[],
) =>
  matchByKeys({
    left,
    right,
    exactBasis: "field-signature",
    fallbackBases: [
      {
        basis: "exact-signature",
        key: ({ signatureKey }) => signatureKey,
      },
    ],
  });

export type ManagedMethodMatches = ReturnType<typeof matchMethods>;
export type ManagedFieldMatches = ReturnType<typeof matchFields>;

interface MatchByKeysInput<Item> {
  readonly left: readonly Keyed<Item>[];
  readonly right: readonly Keyed<Item>[];
  readonly exactBasis: ConcreteMatchBasis;
  readonly fallbackBases: readonly {
    readonly basis: ConcreteMatchBasis;
    readonly key: (item: Keyed<Item>) => string | null;
  }[];
}

const matchByKeys = <Item>({
  left,
  right,
  exactBasis,
  fallbackBases,
}: MatchByKeysInput<Item>): {
  readonly pairs: readonly MatchedPair<Item>[];
  readonly ambiguous: readonly Ambiguous<Item>[];
  readonly leftOnly: readonly Keyed<Item>[];
  readonly rightOnly: readonly Keyed<Item>[];
} => {
  const usedLeft = new Set<Keyed<Item>>();
  const usedRight = new Set<Keyed<Item>>();
  const pairs: MatchedPair<Item>[] = [];
  const ambiguous: Ambiguous<Item>[] = [];
  const rounds: readonly {
    readonly basis: ConcreteMatchBasis;
    readonly key: (item: Keyed<Item>) => string | null;
  }[] = [
    { basis: exactBasis, key: ({ exactKey }) => exactKey },
    ...fallbackBases,
  ];
  for (const round of rounds) {
    const leftGroups = groupBy(
      left.filter((item) => !usedLeft.has(item)),
      round.key,
    );
    const rightGroups = groupBy(
      right.filter((item) => !usedRight.has(item)),
      round.key,
    );
    for (const [key, leftItems] of leftGroups) {
      const rightItems = rightGroups.get(key);
      if (rightItems === undefined) continue;
      if (leftItems.length === 1 && rightItems.length === 1) {
        const [leftItem] = leftItems;
        const [rightItem] = rightItems;
        if (leftItem === undefined || rightItem === undefined) continue;
        usedLeft.add(leftItem);
        usedRight.add(rightItem);
        pairs.push({
          left: leftItem,
          right: rightItem,
          basis: round.basis,
          confidence:
            round.basis === "exact-il-signature" ||
            round.basis === "exact-signature" ||
            round.basis === "field-signature"
              ? "exact"
              : "high",
        });
      } else {
        for (const item of leftItems) usedLeft.add(item);
        for (const item of rightItems) usedRight.add(item);
        ambiguous.push({
          left: leftItems,
          right: rightItems,
          basis: round.basis,
        });
      }
    }
  }
  return {
    pairs,
    ambiguous,
    leftOnly: left.filter((item) => !usedLeft.has(item)),
    rightOnly: right.filter((item) => !usedRight.has(item)),
  };
};

const groupBy = <Item>(
  items: readonly Item[],
  keyOf: (item: Item) => string | null,
): Map<string, readonly Item[]> => {
  const grouped = new Map<string, Item[]>();
  for (const item of items) {
    const key = keyOf(item);
    if (key === null) continue;
    const bucket = grouped.get(key) ?? [];
    bucket.push(item);
    grouped.set(key, bucket);
  }
  return grouped;
};

export const keyMembers = (
  left: ManagedMemberComparisonSide,
  right: ManagedMemberComparisonSide,
): {
  readonly methodMatches: ReturnType<typeof matchMethods>;
  readonly fieldMatches: ReturnType<typeof matchFields>;
} => ({
  methodMatches: matchMethods(
    left.result.methods.map(keyMethod),
    right.result.methods.map(keyMethod),
  ),
  fieldMatches: matchFields(
    left.result.fields.map(keyField),
    right.result.fields.map(keyField),
  ),
});

export const parseManagedMemberEvidence = (
  evidence: unknown,
): {
  readonly evidenceId: string;
  readonly result: ManagedMemberInspection;
} => {
  const parsed = parseEvidence(evidence);
  if (parsed.operation !== "inspect_managed_members")
    throw new TypeError("Evidence operation is not inspect_managed_members");
  return {
    evidenceId: parsed.evidence_id,
    result: managedMemberInspectionSchema.parse(parsed.normalized_result),
  };
};
