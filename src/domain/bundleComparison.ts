import { createHash } from "node:crypto";

import { z } from "zod";

import {
  evidenceBundleSchema,
  parseEvidenceBundle,
  serializeEvidenceBundle,
  type EvidenceBundle,
} from "./evidenceBundle.js";
import type { ResidualUnknown } from "./residualUnknown.js";

const evidenceIdSchema = z.string().regex(/^ev_[a-f0-9]{64}$/u);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const classificationSchema = z.enum([
  "added",
  "removed",
  "changed",
  "unknown",
  "history_advanced",
  "history_diverged",
]);

/** Strict bounded input for canonical Evidence bundle comparison. */
export const bundleComparisonInputSchema = z.object({
  left: evidenceBundleSchema,
  right: evidenceBundleSchema,
  record_pairs: z
    .array(
      z.object({
        left_evidence_id: evidenceIdSchema,
        right_evidence_id: evidenceIdSchema,
      }),
    )
    .max(500)
    .default([]),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(500).default(100),
});

const bundleChangeSchema = z.object({
  entity: z.enum(["evidence", "residual_unknown"]),
  key: z.string().min(1),
  classification: classificationSchema,
  conclusion_kind: z.enum([
    "observed_change",
    "contradiction",
    "unresolved_branch",
  ]),
  left_evidence_ids: z.array(evidenceIdSchema),
  right_evidence_ids: z.array(evidenceIdSchema),
  left_digest: digestSchema.nullable(),
  right_digest: digestSchema.nullable(),
  limitations: z.array(z.string()),
});

/** Deterministic classified delta between two canonical Evidence bundles. */
export const bundleComparisonResultSchema = z.object({
  status: z.enum(["unchanged", "changed", "unknown"]),
  left_bundle_sha256: digestSchema,
  right_bundle_sha256: digestSchema,
  summary: z.object({
    records_unchanged: z.number().int().min(0),
    records_added: z.number().int().min(0),
    records_removed: z.number().int().min(0),
    records_changed: z.number().int().min(0),
    unknowns_unchanged: z.number().int().min(0),
    unknowns_added: z.number().int().min(0),
    unknowns_removed: z.number().int().min(0),
    unknowns_advanced: z.number().int().min(0),
    unknowns_diverged: z.number().int().min(0),
    unresolved: z.number().int().min(0),
  }),
  changes: z.object({
    items: z.array(bundleChangeSchema).max(500),
    offset: z.number().int().min(0),
    limit: z.number().int().min(1).max(500),
    total: z.number().int().min(0),
    next_offset: z.number().int().min(0).nullable(),
  }),
  limitations: z.array(z.string()),
});

export type BundleComparisonResult = z.infer<
  typeof bundleComparisonResultSchema
>;
type BundleChange = z.infer<typeof bundleChangeSchema>;
type RecordPair = z.infer<
  typeof bundleComparisonInputSchema
>["record_pairs"][number];

const MAX_ENTITIES = 100_000;

/** Compare canonical bundle membership and only explicitly paired observations. */
export const compareBundles = (
  ...[leftInput, rightInput, recordPairs, offset, limit]: readonly [
    unknown,
    unknown,
    readonly RecordPair[],
    number,
    number,
  ]
): BundleComparisonResult => {
  const left = parseEvidenceBundle(leftInput);
  const right = parseEvidenceBundle(rightInput);
  enforceBounds(left, right);
  const leftDigest = bundleDigest(left);
  const rightDigest = bundleDigest(right);
  const recordResult = compareRecords(left, right, recordPairs);
  const unknownResult = compareUnknowns(left, right);
  const changes = [...recordResult.changes, ...unknownResult.changes].sort(
    compareChanges,
  );
  const page = changes.slice(offset, offset + limit);
  const unresolved = changes.filter(
    ({ conclusion_kind: kind }) => kind !== "observed_change",
  ).length;
  return bundleComparisonResultSchema.parse({
    status:
      leftDigest === rightDigest && changes.length === 0
        ? "unchanged"
        : unresolved > 0
          ? "unknown"
          : "changed",
    left_bundle_sha256: leftDigest,
    right_bundle_sha256: rightDigest,
    summary: {
      ...recordResult.summary,
      ...unknownResult.summary,
      unresolved,
    },
    changes: {
      items: page,
      offset,
      limit,
      total: changes.length,
      next_offset:
        offset + page.length < changes.length ? offset + page.length : null,
    },
    limitations: changes.some(({ limitations }) => limitations.length > 0)
      ? [
          "One-sided membership proves only bundle inclusion or omission, not behavioral absence.",
        ]
      : [],
  });
};

const compareRecords = (
  left: EvidenceBundle,
  right: EvidenceBundle,
  pairs: readonly RecordPair[],
) => {
  const leftIds = new Set(left.records.map(({ evidence_id: id }) => id));
  const rightIds = new Set(right.records.map(({ evidence_id: id }) => id));
  const pairedLeft = new Set<string>();
  const pairedRight = new Set<string>();
  const changes: BundleChange[] = [];
  let changed = 0;
  for (const pair of pairs) {
    if (!leftIds.has(pair.left_evidence_id))
      throw new TypeError(
        `Explicit pair references missing left evidence ${pair.left_evidence_id}`,
      );
    if (!rightIds.has(pair.right_evidence_id))
      throw new TypeError(
        `Explicit pair references missing right evidence ${pair.right_evidence_id}`,
      );
    if (
      pairedLeft.has(pair.left_evidence_id) ||
      pairedRight.has(pair.right_evidence_id)
    )
      throw new TypeError("Explicit evidence pairs must be one-to-one");
    pairedLeft.add(pair.left_evidence_id);
    pairedRight.add(pair.right_evidence_id);
    if (pair.left_evidence_id === pair.right_evidence_id) continue;
    changed += 1;
    changes.push({
      entity: "evidence",
      key: `pair:${pair.left_evidence_id}:${pair.right_evidence_id}`,
      classification: "changed",
      conclusion_kind: "observed_change",
      left_evidence_ids: [pair.left_evidence_id],
      right_evidence_ids: [pair.right_evidence_id],
      left_digest: pair.left_evidence_id.slice(3),
      right_digest: pair.right_evidence_id.slice(3),
      limitations: [],
    });
  }
  const common = [...leftIds].filter(
    (id) => rightIds.has(id) && !pairedLeft.has(id) && !pairedRight.has(id),
  );
  const removed = [...leftIds].filter(
    (id) => !rightIds.has(id) && !pairedLeft.has(id),
  );
  const added = [...rightIds].filter(
    (id) => !leftIds.has(id) && !pairedRight.has(id),
  );
  for (const [classification, ids, side] of [
    ["removed", removed, "left"],
    ["added", added, "right"],
  ] as const)
    for (const id of ids)
      changes.push({
        entity: "evidence",
        key: id,
        classification,
        conclusion_kind: "observed_change",
        left_evidence_ids: side === "left" ? [id] : [],
        right_evidence_ids: side === "right" ? [id] : [],
        left_digest: side === "left" ? id.slice(3) : null,
        right_digest: side === "right" ? id.slice(3) : null,
        limitations: [
          "One-sided membership does not establish behavioral absence.",
        ],
      });
  return {
    changes,
    summary: {
      records_unchanged: common.length + pairs.length - changed,
      records_added: added.length,
      records_removed: removed.length,
      records_changed: changed,
    },
  };
};

const compareUnknowns = (left: EvidenceBundle, right: EvidenceBundle) => {
  const leftHistories = histories(left.unknowns);
  const rightHistories = histories(right.unknowns);
  const ids = [...new Set([...leftHistories.keys(), ...rightHistories.keys()])];
  const changes: BundleChange[] = [];
  const summary = {
    unknowns_unchanged: 0,
    unknowns_added: 0,
    unknowns_removed: 0,
    unknowns_advanced: 0,
    unknowns_diverged: 0,
  };
  for (const id of ids) {
    const leftHistory = leftHistories.get(id);
    const rightHistory = rightHistories.get(id);
    if (leftHistory === undefined || rightHistory === undefined) {
      const added = leftHistory === undefined;
      summary[added ? "unknowns_added" : "unknowns_removed"] += 1;
      changes.push(
        unknownChange(
          id,
          added ? "added" : "removed",
          leftHistory,
          rightHistory,
        ),
      );
      continue;
    }
    const leftDigests = leftHistory.map(
      ({ revision_digest: digest }) => digest,
    );
    const rightDigests = rightHistory.map(
      ({ revision_digest: digest }) => digest,
    );
    if (same(leftDigests, rightDigests)) {
      summary.unknowns_unchanged += 1;
      continue;
    }
    const advanced =
      isPrefix(leftDigests, rightDigests) ||
      isPrefix(rightDigests, leftDigests);
    summary[advanced ? "unknowns_advanced" : "unknowns_diverged"] += 1;
    changes.push(
      unknownChange(
        id,
        advanced ? "history_advanced" : "history_diverged",
        leftHistory,
        rightHistory,
      ),
    );
  }
  return { changes, summary };
};

const unknownChange = (
  id: string,
  classification: BundleChange["classification"],
  left: readonly ResidualUnknown[] | undefined,
  right: readonly ResidualUnknown[] | undefined,
): BundleChange => ({
  entity: "residual_unknown",
  key: id,
  classification,
  conclusion_kind:
    classification === "history_diverged"
      ? "contradiction"
      : classification === "history_advanced"
        ? "observed_change"
        : "unresolved_branch",
  left_evidence_ids: historyEvidenceIds(left ?? []),
  right_evidence_ids: historyEvidenceIds(right ?? []),
  left_digest: left?.at(-1)?.revision_digest ?? null,
  right_digest: right?.at(-1)?.revision_digest ?? null,
  limitations:
    left === undefined || right === undefined
      ? ["A missing unknown history does not establish resolution."]
      : [],
});

const histories = (unknowns: readonly ResidualUnknown[]) => {
  const output = new Map<string, ResidualUnknown[]>();
  for (const unknown of unknowns) {
    const history = output.get(unknown.unknown_id) ?? [];
    history.push(unknown);
    output.set(unknown.unknown_id, history);
  }
  return output;
};

const historyEvidenceIds = (history: readonly ResidualUnknown[]): string[] =>
  [
    ...new Set(
      history.flatMap((item) => [
        ...item.supporting_evidence_ids,
        ...item.contradicting_evidence_ids,
        ...item.mutation_evidence_ids,
        ...(item.resolution?.evidence_ids ?? []),
      ]),
    ),
  ].sort(ascii);

const enforceBounds = (left: EvidenceBundle, right: EvidenceBundle): void => {
  const total =
    left.records.length +
    right.records.length +
    left.unknowns.length +
    right.unknowns.length;
  if (total > MAX_ENTITIES)
    throw new TypeError(`Bundle comparison exceeds ${MAX_ENTITIES} entities`);
};

const bundleDigest = (bundle: EvidenceBundle): string =>
  createHash("sha256").update(serializeEvidenceBundle(bundle)).digest("hex");

const same = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length &&
  left.every((value, index) => value === right[index]);

const isPrefix = (
  shorter: readonly string[],
  longer: readonly string[],
): boolean =>
  shorter.length < longer.length &&
  shorter.every((value, index) => value === longer[index]);

const ascii = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const compareChanges = (left: BundleChange, right: BundleChange): number =>
  ascii(
    [
      left.entity,
      left.key,
      left.classification,
      left.left_digest ?? "",
      left.right_digest ?? "",
    ].join("\u0000"),
    [
      right.entity,
      right.key,
      right.classification,
      right.left_digest ?? "",
      right.right_digest ?? "",
    ].join("\u0000"),
  );
