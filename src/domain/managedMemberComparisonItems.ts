import canonicalize from "canonicalize";

import type { ManagedMemberInspection } from "./managedArtifact.js";
import type {
  CompareManagedMembersInput,
  ManagedMemberComparisonResult,
} from "./managedMemberComparison.js";
import {
  type ManagedFieldMatches,
  type ManagedMethodMatches,
  sha256,
} from "./managedMemberComparisonMatch.js";

type Method = ManagedMemberInspection["methods"]["items"][number];
type Field = ManagedMemberInspection["fields"]["items"][number];
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
  readonly limits: CompareManagedMembersInput["limits"];
}

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
): MethodItem => {
  if (member.left !== undefined) {
    const absenceObserved = context.rightComplete;
    return {
      item_id: `mmc_method_${sha256({ token: member.left.token, side: "left" })}`,
      status: absenceObserved ? "removed" : "unknown",
      left: methodIdentity(member.left),
      right: null,
      match: unmatchedComparison(),
      dimensions: ["availability"],
      evidence_links: [context.leftEvidenceId, context.rightEvidenceId],
      limitations: absenceObserved
        ? []
        : [
            "unknown-within-unobserved-page: The right method page is incomplete, so absence was not observed.",
          ],
    };
  }

  const absenceObserved = context.leftComplete;
  return {
    item_id: `mmc_method_${sha256({ token: member.right.token, side: "right" })}`,
    status: absenceObserved ? "added" : "unknown",
    left: null,
    right: methodIdentity(member.right),
    match: unmatchedComparison(),
    dimensions: ["availability"],
    evidence_links: [context.leftEvidenceId, context.rightEvidenceId],
    limitations: absenceObserved
      ? []
      : [
          "unknown-within-unobserved-page: The left method page is incomplete, so absence was not observed.",
        ],
  };
};

const fieldOnlyItem = (
  member: OneSided<Field>,
  context: ComparisonItemContext,
): FieldItem => {
  if (member.left !== undefined) {
    const absenceObserved = context.rightComplete;
    return {
      item_id: `mmc_field_${sha256({ token: member.left.token, side: "left" })}`,
      status: absenceObserved ? "removed" : "unknown",
      left: fieldIdentity(member.left),
      right: null,
      match: unmatchedComparison(),
      evidence_links: [context.leftEvidenceId, context.rightEvidenceId],
      limitations: absenceObserved
        ? []
        : [
            "unknown-within-unobserved-page: The right field page is incomplete, so absence was not observed.",
          ],
    };
  }

  const absenceObserved = context.leftComplete;
  return {
    item_id: `mmc_field_${sha256({ token: member.right.token, side: "right" })}`,
    status: absenceObserved ? "added" : "unknown",
    left: null,
    right: fieldIdentity(member.right),
    match: unmatchedComparison(),
    evidence_links: [context.leftEvidenceId, context.rightEvidenceId],
    limitations: absenceObserved
      ? []
      : [
          "unknown-within-unobserved-page: The left field page is incomplete, so absence was not observed.",
        ],
  };
};

export const buildMethodItems = (
  matches: ManagedMethodMatches,
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
    items.push(methodOnlyItem({ left: item.item }, context));
  for (const item of matches.rightOnly)
    items.push(methodOnlyItem({ right: item.item }, context));
  return limitItems(items, context.limits.max_method_matches);
};

export const buildFieldItems = (
  matches: ManagedFieldMatches,
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
    items.push(fieldOnlyItem({ left: item.item }, context));
  for (const item of matches.rightOnly)
    items.push(fieldOnlyItem({ right: item.item }, context));
  return limitItems(items, context.limits.max_field_matches);
};

const limitItems = <Item>(
  items: readonly Item[],
  limit: number,
): { readonly items: Item[]; readonly omitted: number } => ({
  items: items.slice(0, limit),
  omitted: Math.max(0, items.length - limit),
});
