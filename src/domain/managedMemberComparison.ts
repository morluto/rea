import { createHash } from "node:crypto";

import canonicalize from "canonicalize";
import { z } from "zod";

import { evidenceSchema, parseEvidence } from "./evidence.js";
import {
  managedMemberInspectionSchema,
  type ManagedMemberInspection,
} from "./managedArtifact.js";
import type { JsonValue } from "./jsonValue.js";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const evidenceIdSchema = z.string().regex(/^ev_[a-f0-9]{64}$/u);
const tokenSchema = z.string().regex(/^0x[0-9a-f]{8}$/u);
const boundedTextSchema = z.string().min(1).max(4_096);

const comparisonLimitsSchema = z.strictObject({
  max_method_matches: z.number().int().min(1).max(50_000).default(10_000),
  max_field_matches: z.number().int().min(0).max(50_000).default(5_000),
  max_candidates: z.number().int().min(1).max(500).default(50),
});

/** Two authenticated managed member observations and deterministic bounds. */
export const compareManagedMembersInputSchema = z
  .strictObject({
    left: evidenceSchema,
    right: evidenceSchema,
    limits: comparisonLimitsSchema.default({
      max_method_matches: 10_000,
      max_field_matches: 5_000,
      max_candidates: 50,
    }),
    unknown_registry_approved: z.literal(true).optional(),
  })
  .superRefine((input, context) => {
    if (input.left.evidence_id === input.right.evidence_id)
      context.addIssue({
        code: "custom",
        path: ["right"],
        message: "Managed member Evidence must be distinct",
      });
  });

const matchBasisSchema = z.enum([
  "exact-il-signature",
  "structural-method-shape",
  "field-signature",
  "none",
]);

const matchStatusSchema = z.enum(["matched", "unmatched", "ambiguous"]);
const itemStatusSchema = z.enum([
  "unchanged",
  "changed",
  "added",
  "removed",
  "unknown",
]);

const memberIdentitySchema = z.strictObject({
  token: tokenSchema,
  declaring_type: z.string().nullable(),
  name: z.string(),
  signature_sha256: digestSchema,
  normalized_il_sha256: digestSchema.nullable(),
});

const methodComparisonItemSchema = z.strictObject({
  item_id: z.string().regex(/^mmc_method_[a-f0-9]{64}$/u),
  status: itemStatusSchema,
  left: memberIdentitySchema.nullable(),
  right: memberIdentitySchema.nullable(),
  match: z.strictObject({
    status: matchStatusSchema,
    basis: matchBasisSchema,
    confidence: z.enum(["exact", "high", "unknown"]),
    candidate_left_tokens: z.array(tokenSchema).max(500),
    candidate_right_tokens: z.array(tokenSchema).max(500),
  }),
  dimensions: z
    .array(
      z.enum([
        "signature",
        "cil",
        "opcode-shape",
        "call-shape",
        "field-shape",
        "exception-shape",
        "availability",
      ]),
    )
    .max(7),
  evidence_links: z.array(evidenceIdSchema).length(2),
  limitations: z.array(boundedTextSchema).max(100),
});

const fieldComparisonItemSchema = z.strictObject({
  item_id: z.string().regex(/^mmc_field_[a-f0-9]{64}$/u),
  status: itemStatusSchema,
  left: memberIdentitySchema.omit({ normalized_il_sha256: true }).nullable(),
  right: memberIdentitySchema.omit({ normalized_il_sha256: true }).nullable(),
  match: z.strictObject({
    status: matchStatusSchema,
    basis: matchBasisSchema,
    confidence: z.enum(["exact", "high", "unknown"]),
    candidate_left_tokens: z.array(tokenSchema).max(500),
    candidate_right_tokens: z.array(tokenSchema).max(500),
  }),
  evidence_links: z.array(evidenceIdSchema).length(2),
  limitations: z.array(boundedTextSchema).max(100),
});

/** Obfuscation-resistant, execution-free managed member comparison. */
export const managedMemberComparisonResultSchema = z.strictObject({
  schema_version: z.literal(1),
  comparison_id: z.string().regex(/^mmc_[a-f0-9]{64}$/u),
  algorithm: z.strictObject({
    name: z.literal("rea-managed-member-comparison"),
    version: z.literal(1),
    token_identity: z.literal("build-local"),
    name_matching: z.literal("not-used"),
  }),
  left: z.strictObject({
    evidence_id: evidenceIdSchema,
    artifact_sha256: digestSchema,
    mvid: z.string().uuid().nullable(),
    module_name: z.string().nullable(),
    metadata_status: z.enum(["absent", "complete", "partial", "malformed"]),
    methods_total: z.number().int().min(0),
    fields_total: z.number().int().min(0),
  }),
  right: z.strictObject({
    evidence_id: evidenceIdSchema,
    artifact_sha256: digestSchema,
    mvid: z.string().uuid().nullable(),
    module_name: z.string().nullable(),
    metadata_status: z.enum(["absent", "complete", "partial", "malformed"]),
    methods_total: z.number().int().min(0),
    fields_total: z.number().int().min(0),
  }),
  summary: z.strictObject({
    unchanged: z.number().int().min(0),
    changed: z.number().int().min(0),
    added: z.number().int().min(0),
    removed: z.number().int().min(0),
    unknown: z.number().int().min(0),
  }),
  matching: z.strictObject({
    exact_il_signature: z.number().int().min(0),
    structural_method_shape: z.number().int().min(0),
    field_signature: z.number().int().min(0),
    ambiguous: z.number().int().min(0),
    unmatched: z.number().int().min(0),
  }),
  methods: z.array(methodComparisonItemSchema).max(50_000),
  fields: z.array(fieldComparisonItemSchema).max(50_000),
  coverage: z.strictObject({
    status: z.enum(["complete-within-inputs", "partial", "truncated"]),
    left_status: z.enum(["complete", "partial", "unavailable"]),
    right_status: z.enum(["complete", "partial", "unavailable"]),
    omitted_methods: z.number().int().min(0),
    omitted_fields: z.number().int().min(0),
    omitted_candidates: z.number().int().min(0),
  }),
  evidence_links: z.array(evidenceIdSchema).length(2),
  limitations: z.array(boundedTextSchema).max(1_000),
});

export type CompareManagedMembersInput = z.infer<
  typeof compareManagedMembersInputSchema
>;
export type ManagedMemberComparisonResult = z.infer<
  typeof managedMemberComparisonResultSchema
>;

type Method = ManagedMemberInspection["methods"]["items"][number];
type Field = ManagedMemberInspection["fields"]["items"][number];
type MethodItem = ManagedMemberComparisonResult["methods"][number];
type FieldItem = ManagedMemberComparisonResult["fields"][number];
type MatchBasis = z.infer<typeof matchBasisSchema>;

/** One authenticated side of a managed member comparison. */
export interface ManagedMemberComparisonSide {
  readonly evidenceId: string;
  readonly result: ManagedMemberInspection;
}

interface Keyed<Item> {
  readonly item: Item;
  readonly exactKey: string | null;
  readonly structuralKey: string;
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

const sha256 = (value: JsonValue): string => {
  const serialized = canonicalize(value);
  if (serialized === undefined)
    throw new TypeError("Managed comparison canonicalization failed");
  return createHash("sha256").update(serialized).digest("hex");
};

/** Compare two parsed managed member observations without name-based matching. */
export const compareManagedMembers = (
  left: ManagedMemberComparisonSide,
  right: ManagedMemberComparisonSide,
  limits: CompareManagedMembersInput["limits"],
): ManagedMemberComparisonResult => {
  const methodMatches = matchMethods(
    left.result.methods.items.map(keyMethod),
    right.result.methods.items.map(keyMethod),
    limits.max_candidates,
  );
  const fieldMatches = matchFields(
    left.result.fields.items.map(keyField),
    right.result.fields.items.map(keyField),
    limits.max_candidates,
  );
  const methodItems = buildMethodItems(
    methodMatches,
    left.evidenceId,
    right.evidenceId,
    limits,
  );
  const fieldItems = buildFieldItems(
    fieldMatches,
    left.evidenceId,
    right.evidenceId,
    limits,
  );
  const allItems = [...methodItems.items, ...fieldItems.items];
  const summary = {
    unchanged: allItems.filter(({ status }) => status === "unchanged").length,
    changed: allItems.filter(({ status }) => status === "changed").length,
    added: allItems.filter(({ status }) => status === "added").length,
    removed: allItems.filter(({ status }) => status === "removed").length,
    unknown: allItems.filter(({ status }) => status === "unknown").length,
  };
  const matching = {
    exact_il_signature: methodItems.items.filter(
      ({ match }) => match.basis === "exact-il-signature",
    ).length,
    structural_method_shape: methodItems.items.filter(
      ({ match }) => match.basis === "structural-method-shape",
    ).length,
    field_signature: fieldItems.items.filter(
      ({ match }) => match.basis === "field-signature",
    ).length,
    ambiguous:
      methodItems.items.filter(({ match }) => match.status === "ambiguous")
        .length +
      fieldItems.items.filter(({ match }) => match.status === "ambiguous")
        .length,
    unmatched: allItems.filter(({ match }) => match.status === "unmatched")
      .length,
  };
  const limitations = comparisonLimitations(
    left.result,
    right.result,
    methodItems.omitted + fieldItems.omitted,
    methodMatches.omittedCandidates + fieldMatches.omittedCandidates,
  );
  const result = {
    schema_version: 1,
    comparison_id: `mmc_${sha256({
      left: left.evidenceId,
      right: right.evidenceId,
      methods: [...methodItems.items],
      fields: [...fieldItems.items],
      limits,
    })}`,
    algorithm: {
      name: "rea-managed-member-comparison",
      version: 1,
      token_identity: "build-local",
      name_matching: "not-used",
    },
    left: sideManifest(left),
    right: sideManifest(right),
    summary,
    matching,
    methods: methodItems.items,
    fields: fieldItems.items,
    coverage: {
      status:
        methodItems.omitted + fieldItems.omitted > 0 ||
        !left.result.methods.complete ||
        !right.result.methods.complete ||
        !left.result.fields.complete ||
        !right.result.fields.complete
          ? "truncated"
          : left.result.coverage.state === "complete" &&
              right.result.coverage.state === "complete"
            ? "complete-within-inputs"
            : "partial",
      left_status: left.result.coverage.state,
      right_status: right.result.coverage.state,
      omitted_methods: methodItems.omitted,
      omitted_fields: fieldItems.omitted,
      omitted_candidates:
        methodMatches.omittedCandidates + fieldMatches.omittedCandidates,
    },
    evidence_links: [left.evidenceId, right.evidenceId],
    limitations,
  } satisfies ManagedMemberComparisonResult;
  return managedMemberComparisonResultSchema.parse(result);
};

const sideManifest = (
  side: ManagedMemberComparisonSide,
): ManagedMemberComparisonResult["left"] => ({
  evidence_id: side.evidenceId,
  artifact_sha256: side.result.artifact.sha256,
  mvid: side.result.module?.mvid ?? null,
  module_name: side.result.module?.name ?? null,
  metadata_status: side.result.metadata.status,
  methods_total: side.result.methods.total,
  fields_total: side.result.fields.total,
});

const keyMethod = (item: Method): Keyed<Method> => ({
  item,
  exactKey:
    item.signature.parse_status === "decoded" &&
    item.body.normalized_il_sha256 !== null
      ? stableKey([
          "method-exact",
          item.signature.raw_sha256,
          item.body.normalized_il_sha256,
        ])
      : null,
  structuralKey: stableKey([
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
    item.body.anchors.map(({ opcode, operand_kind }) => [opcode, operand_kind]),
    item.body.exception_regions.map((region) => [
      region.flags,
      region.try_length,
      region.handler_length,
      region.class_token === null ? null : "type-token",
      region.filter_offset === null ? null : "filter",
    ]),
  ]),
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
  matchByKeys(left, right, maxCandidates, "exact-il-signature", [
    "structural-method-shape",
  ]);

const matchFields = (
  left: readonly Keyed<Field>[],
  right: readonly Keyed<Field>[],
  maxCandidates: number,
) => matchByKeys(left, right, maxCandidates, "field-signature", []);

const matchByKeys = <Item>(
  left: readonly Keyed<Item>[],
  right: readonly Keyed<Item>[],
  maxCandidates: number,
  exactBasis: MatchBasis,
  fallbackBases: readonly MatchBasis[],
): {
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

const buildMethodItems = (
  matches: ReturnType<typeof matchMethods>,
  leftEvidenceId: string,
  rightEvidenceId: string,
  limits: CompareManagedMembersInput["limits"],
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
      evidence_links: [leftEvidenceId, rightEvidenceId],
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
      evidence_links: [leftEvidenceId, rightEvidenceId],
      limitations: [
        "Multiple managed methods share the same non-name identity key; REA did not guess a token remap.",
      ],
    });
  }
  for (const item of matches.leftOnly)
    items.push(
      methodOnlyItem(item.item, leftEvidenceId, rightEvidenceId, true),
    );
  for (const item of matches.rightOnly)
    items.push(
      methodOnlyItem(item.item, leftEvidenceId, rightEvidenceId, false),
    );
  return limitItems(items, limits.max_method_matches);
};

const buildFieldItems = (
  matches: ReturnType<typeof matchFields>,
  leftEvidenceId: string,
  rightEvidenceId: string,
  limits: CompareManagedMembersInput["limits"],
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
      evidence_links: [leftEvidenceId, rightEvidenceId],
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
      evidence_links: [leftEvidenceId, rightEvidenceId],
      limitations: [
        "Multiple managed fields share the same signature; REA did not guess a token remap from names.",
      ],
    });
  for (const item of matches.leftOnly)
    items.push(fieldOnlyItem(item.item, leftEvidenceId, rightEvidenceId, true));
  for (const item of matches.rightOnly)
    items.push(
      fieldOnlyItem(item.item, leftEvidenceId, rightEvidenceId, false),
    );
  return limitItems(items, limits.max_field_matches);
};

const limitItems = <Item>(
  items: readonly Item[],
  limit: number,
): { readonly items: Item[]; readonly omitted: number } => ({
  items: items.slice(0, limit),
  omitted: Math.max(0, items.length - limit),
});

const methodOnlyItem = (
  item: Method,
  leftEvidenceId: string,
  rightEvidenceId: string,
  left: boolean,
): MethodItem => ({
  item_id: `mmc_method_${sha256({ token: item.token, side: left ? "left" : "right" })}`,
  status: left ? "removed" : "added",
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
  evidence_links: [leftEvidenceId, rightEvidenceId],
  limitations: [],
});

const fieldOnlyItem = (
  item: Field,
  leftEvidenceId: string,
  rightEvidenceId: string,
  left: boolean,
): FieldItem => ({
  item_id: `mmc_field_${sha256({ token: item.token, side: left ? "left" : "right" })}`,
  status: left ? "removed" : "added",
  left: left ? fieldIdentity(item) : null,
  right: left ? null : fieldIdentity(item),
  match: {
    status: "unmatched",
    basis: "none",
    confidence: "unknown",
    candidate_left_tokens: [],
    candidate_right_tokens: [],
  },
  evidence_links: [leftEvidenceId, rightEvidenceId],
  limitations: [],
});

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

const comparisonLimitations = (
  left: ManagedMemberInspection,
  right: ManagedMemberInspection,
  omittedItems: number,
  omittedCandidates: number,
): string[] => {
  const limitations: string[] = [
    "Metadata tokens are build-local coordinates; matched pairs are remaps, not persistent identities.",
    "Names are reported as observations but are not used as a matching basis.",
  ];
  if (!left.methods.complete || !right.methods.complete)
    limitations.push("At least one method page is incomplete.");
  if (!left.fields.complete || !right.fields.complete)
    limitations.push("At least one field page is incomplete.");
  if (left.coverage.state !== "complete" || right.coverage.state !== "complete")
    limitations.push("At least one managed member observation is partial.");
  if (omittedItems > 0)
    limitations.push(
      `${String(omittedItems)} comparison items were omitted by output limits.`,
    );
  if (omittedCandidates > 0)
    limitations.push(
      `${String(omittedCandidates)} ambiguous candidates were omitted by candidate limits.`,
    );
  return limitations;
};

/** Extract and authenticate a managed member inspection Evidence record. */
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
