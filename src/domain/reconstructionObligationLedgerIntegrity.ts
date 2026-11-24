import { digestCanonicalValue } from "./canonicalDigest.js";
import { canonicalJson } from "./comparisonSemantics.js";
import { evidenceAuthoritySchema } from "./evidence.js";
import { compareUnicodeCodePoints } from "./unicodeCodePointOrder.js";
import { uniqueSorted } from "./canonicalOrdering.js";

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
  by_evidence_authority: countBy(
    obligations,
    evidenceAuthoritySchema.options,
    ({ authority_references: references }) =>
      references.map(({ authority }) => authority),
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
  const unboundByArtifact = new Map<string, ReconstructionObligation[]>();
  for (const obligation of obligations) {
    const sha256 = obligation.target.artifact_sha256;
    if (
      sha256 === null ||
      obligation.origin !== "generated" ||
      obligation.binding !== null ||
      obligation.source_state === "observed" ||
      obligation.required_original_authority === "static"
    )
      continue;
    const group = unboundByArtifact.get(sha256);
    if (group === undefined) unboundByArtifact.set(sha256, [obligation]);
    else group.push(obligation);
  }
  return [...unboundByArtifact]
    .filter(([, group]) => group.length > OBLIGATION_OVERGENERATION_THRESHOLD)
    .map(([artifactSha256, group]) => {
      const retired = group.filter(
        ({ status }) => status === "out-of-scope",
      ).length;
      return {
        artifactSha256,
        total: group.length,
        retired,
        unreviewed: group.length - retired,
        families: uniqueSorted(group.map(({ family }) => family)),
      };
    });
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
 * A retained ledger's limitations without the advisory ones its obligations
 * imply. The advisory text is re-derived from the obligations, not parsed.
 */
export const reconstructionObligationClosureLimitations = (
  obligations: readonly ReconstructionObligation[],
  limitations: readonly string[],
): string[] => {
  const advisory = new Set(
    reconstructionObligationOvergeneration(obligations).map(
      reconstructionObligationOvergenerationLimitation,
    ),
  );
  return limitations.filter((limitation) => !advisory.has(limitation));
};

/**
 * Derive closure status from required obligations, their diagnostic facts,
 * and the limitations that bound closure (advisory limitations excluded).
 */
export const reconstructionObligationLedgerStatus = (
  obligations: readonly ReconstructionObligation[],
  limitations: readonly string[],
): ReconstructionObligationLedger["status"] => {
  if (obligations.length === 0) return "unknown";
  const requiredOpen = obligations.filter(
    ({ required, status }) => required && status !== "verified",
  );
  // A retired claim reports its disposition status, not "contradicted", yet
  // its authenticated contradiction stays visible and still fails closure.
  if (
    requiredOpen.some(
      ({ status, diagnostics }) =>
        status === "contradicted" ||
        hasReconstructionObligationDiagnostic(diagnostics, "contradiction") ||
        hasReconstructionObligationDiagnostic(diagnostics, "verifier-failed") ||
        hasReconstructionObligationDiagnostic(diagnostics, "fixture-failed"),
    )
  )
    return "failed";
  if (limitations.length > 0) return "unknown";
  if (requiredOpen.some(({ status }) => status === "unknown")) return "unknown";
  return requiredOpen.length === 0 ? "ready" : "open";
};

/** Coverage from the limitations that bound closure (advisory ones excluded). */
export const reconstructionObligationCoverage = (
  limitations: readonly string[],
): ReconstructionObligationLedger["coverage"] => ({
  status: limitations.length === 0 ? "complete" : "partial",
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
