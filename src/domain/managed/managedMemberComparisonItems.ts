import canonicalize from "canonicalize";

import type { ManagedMemberInspection } from "./managedArtifact.js";
import type { ManagedMemberComparisonResult } from "./managedMemberComparison.js";
import {
  type ManagedFieldMatches,
  type ManagedMethodMatches,
  sha256,
} from "./managedMemberComparisonMatch.js";

type Method = ManagedMemberInspection["methods"][number];
type Field = ManagedMemberInspection["fields"][number];
type MethodItem = ManagedMemberComparisonResult["methods"][number];
type FieldItem = ManagedMemberComparisonResult["fields"][number];
type UnmatchedComparison = Extract<
  MethodItem["match"],
  { readonly status: "unmatched" }
>;

type OneSided<Item> =
  | { readonly left: Item; readonly right?: never }
  | { readonly left?: never; readonly right: Item };

interface ComparisonItemContext {
  readonly leftEvidenceId: string;
  readonly rightEvidenceId: string;
  readonly leftComplete: boolean;
  readonly rightComplete: boolean;
}

/** Declared type and name of each unpaired member, per side, whose signature was not decoded. */
interface UndecodedOneSidedNames {
  readonly left: ReadonlySet<string>;
  readonly right: ReadonlySet<string>;
}

const methodDimensions = (
  left: Method,
  right: Method,
): {
  readonly dimensions: MethodItem["dimensions"];
  readonly bodyUnknown: boolean;
} => {
  const dimensions: MethodItem["dimensions"] = [];
  if (left.flags !== right.flags || left.impl_flags !== right.impl_flags)
    dimensions.push("metadata");
  if (left.signature.raw_sha256 !== right.signature.raw_sha256)
    dimensions.push("signature");
  const leftBodyComplete =
    left.body.status === "present" && left.body.truncated_instructions === 0;
  const rightBodyComplete =
    right.body.status === "present" && right.body.truncated_instructions === 0;
  const bothAbsent =
    left.body.status === "absent" && right.body.status === "absent";
  if (
    (left.body.status === "absent" && rightBodyComplete) ||
    (right.body.status === "absent" && leftBodyComplete)
  )
    dimensions.push("availability");
  if (bothAbsent) return { dimensions, bodyUnknown: false };
  if (!leftBodyComplete || !rightBodyComplete)
    return { dimensions, bodyUnknown: true };
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
  return { dimensions, bodyUnknown: false };
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

const unmatchedComparison = (): UnmatchedComparison => ({
  status: "unmatched",
  basis: "none",
  confidence: "unknown",
  candidate_left_tokens: [],
  candidate_right_tokens: [],
});

const methodOnlyItem = (
  member: OneSided<Method>,
  context: ComparisonItemContext,
  undecoded: UndecodedOneSidedNames,
): MethodItem => {
  if (member.left !== undefined) {
    const limitations = absenceLimitations(member.left, {
      oppositeComplete: context.rightComplete,
      oppositeUndecodedNames: undecoded.right,
      opposite: "right",
      inventory: "method",
    });
    return {
      item_id: `mmc_method_${sha256({ token: member.left.token, side: "left" })}`,
      status: limitations.length === 0 ? "removed" : "unknown",
      left: methodIdentity(member.left),
      right: null,
      match: unmatchedComparison(),
      dimensions: ["availability"],
      evidence_links: [context.leftEvidenceId, context.rightEvidenceId],
      limitations,
    };
  }

  const limitations = absenceLimitations(member.right, {
    oppositeComplete: context.leftComplete,
    oppositeUndecodedNames: undecoded.left,
    opposite: "left",
    inventory: "method",
  });
  return {
    item_id: `mmc_method_${sha256({ token: member.right.token, side: "right" })}`,
    status: limitations.length === 0 ? "added" : "unknown",
    left: null,
    right: methodIdentity(member.right),
    match: unmatchedComparison(),
    dimensions: ["availability"],
    evidence_links: [context.leftEvidenceId, context.rightEvidenceId],
    limitations,
  };
};

/**
 * Why a one-sided member's absence from the other inventory was not
 * observed: that inventory is incomplete, the member's own signature was not
 * decoded, so no shape round could seek a changed counterpart, or the other
 * inventory has an unpaired (one-sided or ambiguous) same-named member whose
 * signature was not decoded, which may be this member with a changed
 * signature.
 */
const absenceLimitations = (
  member: Method | Field,
  opposite: {
    readonly oppositeComplete: boolean;
    readonly oppositeUndecodedNames: ReadonlySet<string>;
    readonly opposite: "left" | "right";
    readonly inventory: "method" | "field";
  },
): string[] => [
  ...(opposite.oppositeComplete
    ? []
    : [
        `unknown-within-incomplete-metadata: The ${opposite.opposite} ${opposite.inventory} inventory is incomplete, so absence was not observed.`,
      ]),
  ...(member.signature.parse_status === "decoded"
    ? []
    : [
        `signature-not-decoded: The member's ${member.signature.parse_status} signature was compared only by exact declared type, name, and raw bytes, so a changed or renamed counterpart could not be sought.`,
      ]),
  ...(member.signature.parse_status === "decoded" &&
  opposite.oppositeUndecodedNames.has(declaredName(member))
    ? [
        `counterpart-signature-not-decoded: The ${opposite.opposite} ${opposite.inventory} inventory has an unpaired member with the same declared type and name whose signature was not decoded, so it may be this member with a changed signature.`,
      ]
    : []),
];

const declaredName = (member: Method | Field): string =>
  JSON.stringify([member.declaring_type, member.name]);

/**
 * Declared names of unpaired members whose signature was not decoded: one-sided
 * members and candidates of ambiguous groups, which also remain unpaired.
 */
const undecodedOneSidedNames = (members: {
  readonly leftOnly: readonly { readonly item: Method | Field }[];
  readonly rightOnly: readonly { readonly item: Method | Field }[];
  readonly ambiguous: readonly {
    readonly left: readonly { readonly item: Method | Field }[];
    readonly right: readonly { readonly item: Method | Field }[];
  }[];
}): UndecodedOneSidedNames => {
  const names = (side: readonly { readonly item: Method | Field }[]) =>
    new Set(
      side
        .filter(({ item }) => item.signature.parse_status !== "decoded")
        .map(({ item }) => declaredName(item)),
    );
  return {
    left: names([
      ...members.leftOnly,
      ...members.ambiguous.flatMap(({ left }) => left),
    ]),
    right: names([
      ...members.rightOnly,
      ...members.ambiguous.flatMap(({ right }) => right),
    ]),
  };
};

const fieldOnlyItem = (
  member: OneSided<Field>,
  context: ComparisonItemContext,
  undecoded: UndecodedOneSidedNames,
): FieldItem => {
  if (member.left !== undefined) {
    const limitations = absenceLimitations(member.left, {
      oppositeComplete: context.rightComplete,
      oppositeUndecodedNames: undecoded.right,
      opposite: "right",
      inventory: "field",
    });
    return {
      item_id: `mmc_field_${sha256({ token: member.left.token, side: "left" })}`,
      status: limitations.length === 0 ? "removed" : "unknown",
      left: fieldIdentity(member.left),
      right: null,
      match: unmatchedComparison(),
      evidence_links: [context.leftEvidenceId, context.rightEvidenceId],
      limitations,
    };
  }

  const limitations = absenceLimitations(member.right, {
    oppositeComplete: context.leftComplete,
    oppositeUndecodedNames: undecoded.left,
    opposite: "left",
    inventory: "field",
  });
  return {
    item_id: `mmc_field_${sha256({ token: member.right.token, side: "right" })}`,
    status: limitations.length === 0 ? "added" : "unknown",
    left: null,
    right: fieldIdentity(member.right),
    match: unmatchedComparison(),
    evidence_links: [context.leftEvidenceId, context.rightEvidenceId],
    limitations,
  };
};

/**
 * Name the identity key an ambiguous group shares. The exact-signature key
 * already includes the declared type and name, so names cannot separate it.
 */
const ambiguityLimitation = (
  members: "methods" | "fields",
  basis: MethodItem["match"]["basis"],
): string =>
  basis === "exact-signature"
    ? `Multiple managed ${members} share the same declared type, name, and raw signature; REA did not guess a token remap.`
    : members === "methods"
      ? "Multiple managed methods share the same non-name identity key; REA did not guess a token remap."
      : "Multiple managed fields share the same signature; REA did not guess a token remap from names.";

export const buildMethodItems = (
  matches: ManagedMethodMatches,
  context: ComparisonItemContext,
): MethodItem[] => {
  const items: MethodItem[] = [];
  for (const pair of matches.pairs) {
    const { dimensions: observedDimensions, bodyUnknown } = methodDimensions(
      pair.left.item,
      pair.right.item,
    );
    const dimensions = bodyUnknown
      ? [...observedDimensions, "body-coverage" as const]
      : observedDimensions;
    const observedChange = observedDimensions.length > 0;
    items.push({
      item_id: `mmc_method_${sha256({
        left: pair.left.item.token,
        right: pair.right.item.token,
        basis: pair.basis,
      })}`,
      status: observedChange
        ? "changed"
        : bodyUnknown
          ? "unknown"
          : "unchanged",
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
      limitations: bodyUnknown
        ? [
            "Method body facets are unknown because at least one side has unavailable or partial body data.",
          ]
        : [],
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
      limitations: [ambiguityLimitation("methods", ambiguous.basis)],
    });
  }
  const undecoded = undecodedOneSidedNames(matches);
  for (const item of matches.leftOnly)
    items.push(methodOnlyItem({ left: item.item }, context, undecoded));
  for (const item of matches.rightOnly)
    items.push(methodOnlyItem({ right: item.item }, context, undecoded));
  return items;
};

export const buildFieldItems = (
  matches: ManagedFieldMatches,
  context: ComparisonItemContext,
): FieldItem[] => {
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
      limitations: [ambiguityLimitation("fields", ambiguous.basis)],
    });
  const undecoded = undecodedOneSidedNames(matches);
  for (const item of matches.leftOnly)
    items.push(fieldOnlyItem({ left: item.item }, context, undecoded));
  for (const item of matches.rightOnly)
    items.push(fieldOnlyItem({ right: item.item }, context, undecoded));
  return items;
};
