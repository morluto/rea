import { digestCanonicalValue } from "./canonicalDigest.js";
import { canonicalJson } from "./comparisonSemantics.js";
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
  by_evidence_authority: countBy(
    obligations,
    ["candidate", "observed", "reviewed", "unknown"],
    ({ source_state }) => source_state,
  ),
});

/** Derive closure status from required obligations and their diagnostic facts. */
export const reconstructionObligationLedgerStatus = (
  obligations: readonly ReconstructionObligation[],
  limitations: readonly string[],
): ReconstructionObligationLedger["status"] => {
  if (obligations.length === 0) return "unknown";
  const requiredOpen = obligations.filter(
    ({ required, status }) => required && status !== "verified",
  );
  if (
    requiredOpen.some(
      ({ status, diagnostics }) =>
        status === "contradicted" ||
        hasReconstructionObligationDiagnostic(diagnostics, "verifier-failed"),
    )
  )
    return "failed";
  if (limitations.length > 0) return "unknown";
  if (requiredOpen.some(({ status }) => status === "unknown")) return "unknown";
  return requiredOpen.length === 0 ? "ready" : "open";
};

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

const countBy = <Value extends string, Item>(
  items: readonly Item[],
  values: readonly Value[],
  valueFor: (item: Item) => Value,
): { key: Value; count: number }[] =>
  values.map((value) => ({
    key: value,
    count: items.filter((item) => valueFor(item) === value).length,
  }));
