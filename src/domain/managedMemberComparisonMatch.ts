import { createHash } from "node:crypto";

import canonicalize from "canonicalize";

import { parseEvidence } from "./evidence.js";
import {
  managedMemberInspectionSchema,
  type ManagedMemberInspection,
} from "./managedArtifact.js";
import type {
  ManagedMemberComparisonResult,
  ManagedMemberComparisonSide,
} from "./managedMemberComparison.js";
import type { JsonValue } from "./jsonValue.js";

export const sha256 = (value: JsonValue): string => {
  const serialized = canonicalize(value);
  if (serialized === undefined)
    throw new TypeError("Managed comparison canonicalization failed");
  return createHash("sha256").update(serialized).digest("hex");
};

type Method = ManagedMemberInspection["methods"]["items"][number];
type Field = ManagedMemberInspection["fields"]["items"][number];
type MatchBasis =
  ManagedMemberComparisonResult["methods"][number]["match"]["basis"];
type ConcreteMatchBasis = Exclude<MatchBasis, "none">;

interface Keyed<Item> {
  readonly item: Item;
  readonly exactKey: string | null;
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
    item.signature.parse_status === "decoded" &&
    item.body.status === "present" &&
    item.body.normalized_il_sha256 !== null
      ? stableKey([
          "method-exact",
          item.signature.raw_sha256,
          item.body.normalized_il_sha256,
        ])
      : null,
  structuralKey:
    item.body.status === "present"
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
  maxCandidates: number,
) =>
  matchByKeys({
    left,
    right,
    maxCandidates,
    exactBasis: "exact-il-signature",
    fallbackBases: ["structural-method-shape"],
  });

const matchFields = (
  left: readonly Keyed<Field>[],
  right: readonly Keyed<Field>[],
  maxCandidates: number,
) =>
  matchByKeys({
    left,
    right,
    maxCandidates,
    exactBasis: "field-signature",
    fallbackBases: [],
  });

export type ManagedMethodMatches = ReturnType<typeof matchMethods>;
export type ManagedFieldMatches = ReturnType<typeof matchFields>;

interface MatchByKeysInput<Item> {
  readonly left: readonly Keyed<Item>[];
  readonly right: readonly Keyed<Item>[];
  readonly maxCandidates: number;
  readonly exactBasis: ConcreteMatchBasis;
  readonly fallbackBases: readonly ConcreteMatchBasis[];
}

const matchByKeys = <Item>({
  left,
  right,
  maxCandidates,
  exactBasis,
  fallbackBases,
}: MatchByKeysInput<Item>): {
  readonly pairs: readonly MatchedPair<Item>[];
  readonly ambiguous: readonly Ambiguous<Item>[];
  readonly leftOnly: readonly Keyed<Item>[];
  readonly rightOnly: readonly Keyed<Item>[];
  readonly omittedCandidates: number;
} => {
  const usedLeft = new Set<Keyed<Item>>();
  const usedRight = new Set<Keyed<Item>>();
  const pairs: MatchedPair<Item>[] = [];
  const ambiguous: Ambiguous<Item>[] = [];
  let omittedCandidates = 0;
  const rounds: readonly {
    readonly basis: ConcreteMatchBasis;
    readonly key: (item: Keyed<Item>) => string | null;
  }[] = [
    { basis: exactBasis, key: ({ exactKey }) => exactKey },
    ...fallbackBases.map((basis) => ({
      basis,
      key: ({ structuralKey }: Keyed<Item>) => structuralKey,
    })),
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
            round.basis === "field-signature"
              ? "exact"
              : "high",
        });
      } else {
        for (const item of leftItems) usedLeft.add(item);
        for (const item of rightItems) usedRight.add(item);
        omittedCandidates += Math.max(
          0,
          leftItems.length + rightItems.length - maxCandidates * 2,
        );
        ambiguous.push({
          left: leftItems.slice(0, maxCandidates),
          right: rightItems.slice(0, maxCandidates),
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
    omittedCandidates,
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
  maxCandidates: number,
): {
  readonly methodMatches: ReturnType<typeof matchMethods>;
  readonly fieldMatches: ReturnType<typeof matchFields>;
} => ({
  methodMatches: matchMethods(
    left.result.methods.items.map(keyMethod),
    right.result.methods.items.map(keyMethod),
    maxCandidates,
  ),
  fieldMatches: matchFields(
    left.result.fields.items.map(keyField),
    right.result.fields.items.map(keyField),
    maxCandidates,
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
