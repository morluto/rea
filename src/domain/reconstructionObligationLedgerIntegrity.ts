import { digestCanonicalValue } from "./canonicalDigest.js";
import { canonicalJson } from "./comparisonSemantics.js";
import { evidenceAuthoritySchema } from "./evidence.js";
import { compareUnicodeCodePoints } from "./unicodeCodePointOrder.js";

import type {
  ReconstructionObligation,
  ReconstructionObligationLedger,
} from "./reconstructionObligationLedgerSchemas.js";

/** Derive the ledger summary from the obligation facts. */
export const summarizeReconstructionObligations = (
  obligations: readonly ReconstructionObligation[],
): ReconstructionObligationLedger["summary"] => ({
  total: obligations.length,
  required: obligations.filter(({ required }) => required).length,
  verified: obligations.filter(({ status }) => status === "verified").length,
  required_open: obligations.filter(
    ({ required, status }) => required && status !== "verified",
  ).length,
  by_status: countBy(
    obligations,
    [
      "unowned",
      "characterized",
      "implemented",
      "verified",
      "contradicted",
      "blocked",
      "out-of-scope",
      "unknown",
    ],
    ({ status }) => status,
  ),
  by_application_layer: countBy(
    obligations,
    [
      "cli",
      "protocol",
      "electron",
      "persistence",
      "process",
      "runtime",
      "packaging",
      "native-abi",
      "application",
      "other",
    ],
    ({ application_layer }) => application_layer,
  ),
  // Evidence that observes another artifact is listed but is not authority
  // for this obligation, so it is not counted.
  by_evidence_authority: countBy(
    obligations,
    evidenceAuthoritySchema.options,
    ({ authority_references: references }) =>
      references.flatMap(({ authority, state }) =>
        state === "other-artifact" ? [] : [authority],
      ),
  ),
  by_source_state: countBy(
    obligations,
    ["candidate", "observed", "reviewed", "unknown"],
    ({ source_state }) => source_state,
  ),
});

/**
 * Generated obligations in one artifact that have neither runtime authority
 * nor a manifest binding. Above this count the artifact is reported as
 * over-generated: each such claim demands several fixtures and a verifier
 * before any evidence shows the boundary is reachable, so blind fixture work
 * would dominate the reconstruction and decoy boundaries in dead code could
 * absorb it. Hand-written preload or IPC surfaces rarely exceed this count;
 * larger applications first need runtime authority or reviewed dispositions.
 */
export const OBLIGATION_OVERGENERATION_THRESHOLD = 20;

/** One over-generated artifact: its unbound, static-only generated claims. */
export interface ReconstructionObligationOvergeneration {
  readonly artifactSha256: string;
  readonly total: number;
  readonly retired: number;
  readonly unreviewed: number;
  readonly families: readonly string[];
}

/**
 * Over-generated artifacts, derived from the obligations alone. Every
 * candidate stays in the ledger and required; this is a count, not truncation,
 * so it is advisory and never bounds coverage or closure. Families whose
 * original authority is static (native boundaries) are characterized without
 * runtime authority, so they are not counted.
 */
export const reconstructionObligationOvergeneration = (
  obligations: readonly ReconstructionObligation[],
): ReconstructionObligationOvergeneration[] => {
  // One pass: each artifact's tally is created once and updated in place.
  const tallies = foldByKey(
    obligations,
    (obligation) =>
      obligation.origin !== "generated" ||
      obligation.binding !== null ||
      obligation.source_state === "observed" ||
      obligation.required_original_authority === "static"
        ? null
        : obligation.target.artifact_sha256,
    () => ({ total: 0, retired: 0, families: new Set<string>() }),
    (tally, { status, family }) => {
      tally.total += 1;
      if (status === "out-of-scope") tally.retired += 1;
      tally.families.add(family);
    },
  );
  return [...tallies]
    .filter(([, { total }]) => total > OBLIGATION_OVERGENERATION_THRESHOLD)
    .map(([artifactSha256, { total, retired, families }]) => ({
      artifactSha256,
      total,
      retired,
      unreviewed: total - retired,
      families: [...families].sort(compareUnicodeCodePoints),
    }));
};

/**
 * Fold items into one accumulator per key. Each accumulator is created once,
 * on its key's first item, and updated in place for every later item, so
 * grouping never copies a group. Items whose key is null are skipped.
 */
export const foldByKey = <Item, Key, Accumulator>(
  items: readonly Item[],
  keyOf: (item: Item) => Key | null,
  create: () => Accumulator,
  add: (accumulator: Accumulator, item: Item) => void,
): Map<Key, Accumulator> => {
  const accumulators = new Map<Key, Accumulator>();
  for (const item of items) {
    const key = keyOf(item);
    if (key === null) continue;
    let accumulator = accumulators.get(key);
    if (accumulator === undefined) {
      accumulator = create();
      accumulators.set(key, accumulator);
    }
    add(accumulator, item);
  }
  return accumulators;
};

/** Render the advisory limitation for one over-generated artifact. */
export const reconstructionObligationOvergenerationLimitation = ({
  artifactSha256,
  total,
  retired,
  unreviewed,
  families,
}: ReconstructionObligationOvergeneration): string =>
  `obligation-overgeneration: artifact ${artifactSha256} has ${String(total)} generated obligations with no runtime authority and no manifest binding (families: ${families.join(", ")}), above the threshold of ${String(OBLIGATION_OVERGENERATION_THRESHOLD)}; ${String(unreviewed)} still unreviewed, ${String(retired)} retired by reviewed disposition. Stop: do not write fixtures or verifiers for these candidates; obtain runtime authority for the artifact or record a reviewed disposition for each still-unreviewed decoy first.`;

/**
 * Kind of one ledger limitation. Only `closure` limitations bound coverage
 * and status; `obligation-overgeneration` is advisory. The sentence is display
 * text only and is never matched to find the kind.
 */
export type ReconstructionObligationLimitationKind = NonNullable<
  ReconstructionObligationLedger["limitation_kinds"]
>[number];

/**
 * Every count of closure-bounding limitations consistent with a retained
 * ledger. Recorded kinds decide it exactly. A ledger without kinds was
 * retained before they were recorded, and its kinds are derived from its
 * obligations, never from its sentences: either it predates advisory
 * limitations, so every limitation bounds closure, or it lists one advisory
 * limitation per over-generated artifact its obligations imply.
 */
export const reconstructionObligationClosureLimitationCounts = (
  obligations: readonly ReconstructionObligation[],
  limitations: readonly string[],
  kinds: readonly ReconstructionObligationLimitationKind[] | undefined,
): number[] => {
  if (kinds !== undefined) {
    let closure = 0;
    for (const kind of kinds) if (kind === "closure") closure += 1;
    return [closure];
  }
  const advisory = reconstructionObligationOvergeneration(obligations).length;
  return [
    ...new Set([
      limitations.length,
      Math.max(0, limitations.length - advisory),
    ]),
  ];
};

/**
 * Derive closure status from required obligations, their diagnostic facts,
 * and the number of limitations that bound closure (advisory ones excluded).
 * `legacy` is the rule a ledger retained before limitation kinds were
 * recorded was written under, where diagnostics never outranked statuses.
 */
export const reconstructionObligationLedgerStatus = (
  obligations: readonly ReconstructionObligation[],
  closureLimitationCount: number,
  legacy = false,
): ReconstructionObligationLedger["status"] => {
  if (obligations.length === 0) return "unknown";
  const requiredOpen = obligations.filter(
    ({ required, status }) => required && status !== "verified",
  );
  // A retired claim reports its disposition status, not "contradicted" or
  // "unknown", yet the diagnostics behind those statuses stay visible and
  // still decide closure, so retiring a claim never improves the ledger.
  if (
    requiredOpen.some(
      ({ status, diagnostics }) =>
        status === "contradicted" ||
        (!legacy &&
          hasReconstructionObligationDiagnostic(
            diagnostics,
            "contradiction",
          )) ||
        hasReconstructionObligationDiagnostic(diagnostics, "verifier-failed") ||
        hasReconstructionObligationDiagnostic(diagnostics, "fixture-failed"),
    )
  )
    return "failed";
  if (closureLimitationCount > 0) return "unknown";
  // Only retirement may hide unknown residue behind its status; any other
  // claim is read by its status alone, as ledgers always have been.
  if (
    requiredOpen.some(
      ({ status, diagnostics }) =>
        status === "unknown" ||
        (!legacy &&
          status === "out-of-scope" &&
          (hasReconstructionObligationDiagnostic(
            diagnostics,
            "duplicate-definition",
          ) ||
            hasReconstructionObligationDiagnostic(
              diagnostics,
              "residual-unknown",
            ) ||
            hasReconstructionObligationDiagnostic(
              diagnostics,
              "unavailable-authority",
            ))),
    )
  )
    return "unknown";
  return requiredOpen.length === 0 ? "ready" : "open";
};

/** Coverage from the number of limitations that bound closure. */
export const reconstructionObligationCoverage = (
  closureLimitationCount: number,
): ReconstructionObligationLedger["coverage"] => ({
  status: closureLimitationCount === 0 ? "complete" : "partial",
});

export const reconstructionObligationReports = (
  obligations: readonly ReconstructionObligation[],
): ReconstructionObligationLedger["reports"] => ({
  missing_owner_obligation_ids: obligationIdsWith(obligations, "missing-owner"),
  missing_verifier_obligation_ids: obligationIdsWith(
    obligations,
    "missing-verifier",
  ),
  contradicted_obligation_ids: obligationIdsWith(obligations, "contradiction"),
  residual_unknown_ids: [
    ...new Set(obligations.flatMap(({ residual_unknown_ids: ids }) => ids)),
  ].sort(compareUnicodeCodePoints),
});

export const reconstructionObligationOwnershipGraph = (
  obligations: readonly ReconstructionObligation[],
): ReconstructionObligationLedger["ownership_graph"] =>
  obligations
    .flatMap((obligation) =>
      obligation.binding === null
        ? []
        : [
            {
              obligation_id: obligation.obligation_id,
              module_path: obligation.binding.owner.module_path,
              symbol: obligation.binding.owner.symbol,
            },
          ],
    )
    .sort(obligationEdgeOrder);

export const reconstructionObligationDependencyGraph = (
  obligations: readonly ReconstructionObligation[],
): ReconstructionObligationLedger["dependency_graph"] =>
  obligations
    .flatMap((obligation) =>
      obligation.dependency_obligation_ids.map((dependencyId) => ({
        obligation_id: obligation.obligation_id,
        depends_on_obligation_id: dependencyId,
      })),
    )
    .sort(obligationEdgeOrder);

/** Evidence attached to facts serialized on an obligation. */
export const reconstructionObligationEvidenceIds = (
  obligations: readonly ReconstructionObligation[],
): string[] =>
  [
    ...new Set(
      obligations.flatMap((obligation) => [
        ...obligation.authority_references.map(({ evidence_id: id }) => id),
        ...obligation.observed_cases.map(({ evidence_id: id }) => id),
        ...(obligation.binding === null
          ? []
          : [
              ...obligation.binding.original_cases.map(
                ({ evidence_id: id }) => id,
              ),
              ...obligation.binding.fixtures.flatMap(
                ({ evidence_ids: ids }) => ids,
              ),
              ...(obligation.binding.verifier === null
                ? []
                : [obligation.binding.verifier.result_evidence_id]),
            ]),
      ]),
    ),
  ].sort(compareUnicodeCodePoints);

const obligationEdgeOrder = (
  left: { readonly obligation_id: string },
  right: { readonly obligation_id: string },
): number =>
  compareUnicodeCodePoints(canonicalJson(left), canonicalJson(right));

const obligationIdsWith = (
  obligations: readonly ReconstructionObligation[],
  code: ReconstructionObligation["diagnostics"][number]["code"],
): string[] =>
  obligations
    .filter(({ diagnostics }) =>
      hasReconstructionObligationDiagnostic(diagnostics, code),
    )
    .map(({ obligation_id: id }) => id)
    .sort(compareUnicodeCodePoints);

export const hasReconstructionObligationDiagnostic = (
  diagnostics: Readonly<ReconstructionObligation["diagnostics"]>,
  code: ReconstructionObligation["diagnostics"][number]["code"],
): boolean => diagnostics.some((diagnostic) => diagnostic.code === code);

/** Recompute the closure commitment from the fields carried by a ledger. */
export const reconstructionObligationLedgerClosureDigest = (ledger: {
  readonly status: ReconstructionObligationLedger["status"];
  readonly coverage: ReconstructionObligationLedger["coverage"];
  readonly summary: ReconstructionObligationLedger["summary"];
  readonly reports: ReconstructionObligationLedger["reports"];
  readonly ownership_graph: ReconstructionObligationLedger["ownership_graph"];
  readonly dependency_graph: ReconstructionObligationLedger["dependency_graph"];
  readonly obligations: ReconstructionObligationLedger["obligations"];
  readonly evidence_links: ReconstructionObligationLedger["evidence_links"];
  readonly limitations: ReconstructionObligationLedger["limitations"];
  readonly limitation_kinds?: ReconstructionObligationLedger["limitation_kinds"];
}): string =>
  digestCanonicalValue(
    {
      schema: "ReconstructionObligationClosure",
      status: ledger.status,
      coverage: ledger.coverage,
      summary: ledger.summary,
      reports: ledger.reports,
      ownership_graph: ledger.ownership_graph,
      dependency_graph: ledger.dependency_graph,
      obligations: ledger.obligations,
      evidence_links: ledger.evidence_links,
      limitations: ledger.limitations,
      // Absent from ledgers retained before kinds were recorded, whose
      // commitment therefore stays unchanged.
      ...(ledger.limitation_kinds === undefined
        ? {}
        : { limitation_kinds: ledger.limitation_kinds }),
    },
    "Reconstruction obligation ledger",
  );

/** Count items per key; an item counts once under each distinct key it has. */
const countBy = <Value extends string, Item>(
  items: readonly Item[],
  values: readonly Value[],
  valuesFor: (item: Item) => Value | readonly Value[],
): { key: Value; count: number }[] => {
  const counts = new Map<Value, number>();
  for (const item of items) {
    const itemValues = valuesFor(item);
    for (const value of new Set(
      typeof itemValues === "string" ? [itemValues] : itemValues,
    ))
      counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return values.map((value) => ({ key: value, count: counts.get(value) ?? 0 }));
};
