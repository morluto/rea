import { createHash } from "node:crypto";

import canonicalize from "canonicalize";

import { parseEvidence } from "./evidence.js";
import {
  managedMemberInspectionSchema,
  type ManagedMemberInspection,
} from "./managedArtifact.js";
import type {
  CompareManagedMembersInput,
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
type MethodItem = ManagedMemberComparisonResult["methods"][number];
type FieldItem = ManagedMemberComparisonResult["fields"][number];
type MatchBasis = MethodItem["match"]["basis"];

interface Keyed<Item> {
  readonly item: Item;
  readonly exactKey: string | null;
  readonly structuralKey: string | null;
}

interface MatchedPair<Item> {
  readonly left: Keyed<Item>;
  readonly right: Keyed<Item>;
  readonly basis: MatchBasis;
  readonly confidence: "exact" | "high";
}

interface Ambiguous<Item> {
  readonly left: readonly Keyed<Item>[];
  readonly right: readonly Keyed<Item>[];
  readonly basis: MatchBasis;
}

export interface ComparisonItemContext {
  readonly leftEvidenceId: string;
  readonly rightEvidenceId: string;
  readonly leftComplete: boolean;
  readonly rightComplete: boolean;
  readonly limits: CompareManagedMembersInput["limits"];
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

interface MatchByKeysInput<Item> {
  readonly left: readonly Keyed<Item>[];
  readonly right: readonly Keyed<Item>[];
  readonly maxCandidates: number;
  readonly exactBasis: MatchBasis;
  readonly fallbackBases: readonly MatchBasis[];
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
    readonly basis: MatchBasis;
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

const changedMethodDimensions = (
  left: Method,
  right: Method,
): MethodItem["dimensions"] => {
  const dimensions: MethodItem["dimensions"] = [];
  if (left.signature.raw_sha256 !== right.signature.raw_sha256)
    dimensions.push("signature");
  if (left.body.normalized_il_sha256 !== right.body.normalized_il_sha256)
    dimensions.push("cil");
  if (
    canonicalize(left.body.opcode_counts) !==
    canonicalize(right.body.opcode_counts)
  )
    dimensions.push("opcode-shape");
  if (callShape(left.body.anchors) !== callShape(right.body.anchors))
    dimensions.push("call-shape");
  if (fieldShape(left.body.anchors) !== fieldShape(right.body.anchors))
    dimensions.push("field-shape");
  if (
    canonicalize(left.body.exception_regions) !==
    canonicalize(right.body.exception_regions)
  )
    dimensions.push("exception-shape");
  if (left.body.status !== right.body.status) dimensions.push("availability");
  return dimensions;
};

const callShape = (anchors: Method["body"]["anchors"]): string =>
  JSON.stringify(
    anchors
      .filter(({ operand_kind }) => operand_kind === "method")
      .map(({ opcode, operand_kind }) => [opcode, operand_kind]),
  );

const fieldShape = (anchors: Method["body"]["anchors"]): string =>
  JSON.stringify(
    anchors
      .filter(({ operand_kind }) => operand_kind === "field")
      .map(({ opcode, operand_kind }) => [opcode, operand_kind]),
  );

const methodIdentity = (item: Method): NonNullable<MethodItem["left"]> => ({
  token: item.token,
  declaring_type: item.declaring_type,
  name: item.name,
  signature_sha256: item.signature.raw_sha256,
  normalized_il_sha256: item.body.normalized_il_sha256,
});

const fieldIdentity = (item: Field): NonNullable<FieldItem["left"]> => ({
  token: item.token,
  declaring_type: item.declaring_type,
  name: item.name,
  signature_sha256: item.signature.raw_sha256,
});

const methodOnlyItem = (
  item: Method,
  context: ComparisonItemContext,
  left: boolean,
): MethodItem => {
  const absenceObserved = left ? context.rightComplete : context.leftComplete;
  return {
    item_id: `mmc_method_${sha256({ token: item.token, side: left ? "left" : "right" })}`,
    status: absenceObserved ? (left ? "removed" : "added") : "unknown",
    left: left ? methodIdentity(item) : null,
    right: left ? null : methodIdentity(item),
    match: {
      status: "unmatched",
      basis: "none",
      confidence: "unknown",
      candidate_left_tokens: [],
      candidate_right_tokens: [],
    },
    dimensions: ["availability"],
    evidence_links: [context.leftEvidenceId, context.rightEvidenceId],
    limitations: absenceObserved
      ? []
      : [
          `unknown-within-unobserved-page: The ${left ? "right" : "left"} method page is incomplete, so absence was not observed.`,
        ],
  };
};

const fieldOnlyItem = (
  item: Field,
  context: ComparisonItemContext,
  left: boolean,
): FieldItem => {
  const absenceObserved = left ? context.rightComplete : context.leftComplete;
  return {
    item_id: `mmc_field_${sha256({ token: item.token, side: left ? "left" : "right" })}`,
    status: absenceObserved ? (left ? "removed" : "added") : "unknown",
    left: left ? fieldIdentity(item) : null,
    right: left ? null : fieldIdentity(item),
    match: {
      status: "unmatched",
      basis: "none",
      confidence: "unknown",
      candidate_left_tokens: [],
      candidate_right_tokens: [],
    },
    evidence_links: [context.leftEvidenceId, context.rightEvidenceId],
    limitations: absenceObserved
      ? []
      : [
          `unknown-within-unobserved-page: The ${left ? "right" : "left"} field page is incomplete, so absence was not observed.`,
        ],
  };
};

export const buildMethodItems = (
  matches: ReturnType<typeof matchMethods>,
  context: ComparisonItemContext,
): { readonly items: MethodItem[]; readonly omitted: number } => {
  const items: MethodItem[] = [];
  for (const pair of matches.pairs) {
    const dimensions = changedMethodDimensions(pair.left.item, pair.right.item);
    items.push({
      item_id: `mmc_method_${sha256({
        left: pair.left.item.token,
        right: pair.right.item.token,
        basis: pair.basis,
      })}`,
      status: dimensions.length === 0 ? "unchanged" : "changed",
      left: methodIdentity(pair.left.item),
      right: methodIdentity(pair.right.item),
      match: {
        status: "matched",
        basis: pair.basis,
        confidence: pair.confidence,
        candidate_left_tokens: [],
        candidate_right_tokens: [],
      },
      dimensions,
      evidence_links: [context.leftEvidenceId, context.rightEvidenceId],
      limitations: [],
    });
  }
  for (const ambiguous of matches.ambiguous) {
    items.push({
      item_id: `mmc_method_${sha256({
        left: ambiguous.left.map(({ item }) => item.token),
        right: ambiguous.right.map(({ item }) => item.token),
        basis: ambiguous.basis,
      })}`,
      status: "unknown",
      left: null,
      right: null,
      match: {
        status: "ambiguous",
        basis: ambiguous.basis,
        confidence: "unknown",
        candidate_left_tokens: ambiguous.left.map(({ item }) => item.token),
        candidate_right_tokens: ambiguous.right.map(({ item }) => item.token),
      },
      dimensions: ["availability"],
      evidence_links: [context.leftEvidenceId, context.rightEvidenceId],
      limitations: [
        "Multiple managed methods share the same non-name identity key; REA did not guess a token remap.",
      ],
    });
  }
  for (const item of matches.leftOnly)
    items.push(methodOnlyItem(item.item, context, true));
  for (const item of matches.rightOnly)
    items.push(methodOnlyItem(item.item, context, false));
  return limitItems(items, context.limits.max_method_matches);
};

export const buildFieldItems = (
  matches: ReturnType<typeof matchFields>,
  context: ComparisonItemContext,
): { readonly items: FieldItem[]; readonly omitted: number } => {
  const items: FieldItem[] = [];
  for (const pair of matches.pairs) {
    const changed =
      pair.left.item.signature.raw_sha256 !==
        pair.right.item.signature.raw_sha256 ||
      pair.left.item.flags !== pair.right.item.flags;
    items.push({
      item_id: `mmc_field_${sha256({
        left: pair.left.item.token,
        right: pair.right.item.token,
      })}`,
      status: changed ? "changed" : "unchanged",
      left: fieldIdentity(pair.left.item),
      right: fieldIdentity(pair.right.item),
      match: {
        status: "matched",
        basis: pair.basis,
        confidence: pair.confidence,
        candidate_left_tokens: [],
        candidate_right_tokens: [],
      },
      evidence_links: [context.leftEvidenceId, context.rightEvidenceId],
      limitations: [],
    });
  }
  for (const ambiguous of matches.ambiguous)
    items.push({
      item_id: `mmc_field_${sha256({
        left: ambiguous.left.map(({ item }) => item.token),
        right: ambiguous.right.map(({ item }) => item.token),
      })}`,
      status: "unknown",
      left: null,
      right: null,
      match: {
        status: "ambiguous",
        basis: ambiguous.basis,
        confidence: "unknown",
        candidate_left_tokens: ambiguous.left.map(({ item }) => item.token),
        candidate_right_tokens: ambiguous.right.map(({ item }) => item.token),
      },
      evidence_links: [context.leftEvidenceId, context.rightEvidenceId],
      limitations: [
        "Multiple managed fields share the same signature; REA did not guess a token remap from names.",
      ],
    });
  for (const item of matches.leftOnly)
    items.push(fieldOnlyItem(item.item, context, true));
  for (const item of matches.rightOnly)
    items.push(fieldOnlyItem(item.item, context, false));
  return limitItems(items, context.limits.max_field_matches);
};

const limitItems = <Item>(
  items: readonly Item[],
  limit: number,
): { readonly items: Item[]; readonly omitted: number } => ({
  items: items.slice(0, limit),
  omitted: Math.max(0, items.length - limit),
});

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
