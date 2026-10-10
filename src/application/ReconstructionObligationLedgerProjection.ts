import { createHash } from "node:crypto";

import canonicalize from "canonicalize";

import { canonicalJson } from "../domain/comparisonSemantics.js";
import { compareUnicodeCodePoints } from "../domain/unicodeCodePointOrder.js";

import type {
  ReconstructionObligation,
  ReconstructionObligationLedger,
  ReconstructionObligationManifest,
} from "../domain/reconstructionObligationLedgerSchemas.js";

type DiagnosticCode = ReconstructionObligation["diagnostics"][number]["code"];

export const obligationLedgerCoverage = (
  incomplete: boolean,
): ReconstructionObligationLedger["coverage"] => ({
  status: incomplete ? "partial" : "complete",
});

export const summarizeObligations = (
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
    ({ application_layer: layer }) => layer,
  ),
  by_evidence_authority: countBy(
    obligations,
    ["candidate", "observed", "reviewed", "unknown"],
    ({ source_state: state }) => state,
  ),
});

export const obligationReports = (
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
  ].sort(),
});

export const obligationLedgerEvidenceLinks = (
  obligations: readonly ReconstructionObligation[],
  manifest: ReconstructionObligationManifest,
): string[] =>
  [
    ...new Set([
      ...obligations.flatMap(({ authority_references: references }) =>
        references.map(({ evidence_id: id }) => id),
      ),
      ...manifest.bindings.flatMap((binding) => [
        ...binding.original_cases.map(({ evidence_id: id }) => id),
        ...binding.fixtures.flatMap(({ evidence_ids: ids }) => ids),
        ...(binding.verifier === null
          ? []
          : [binding.verifier.result_evidence_id]),
      ]),
      ...manifest.contradictions.flatMap(({ evidence_ids: ids }) => ids),
    ]),
  ].sort();

export const obligationLedgerStatus = (
  obligations: readonly ReconstructionObligation[],
): ReconstructionObligationLedger["status"] => {
  if (obligations.length === 0) return "unknown";
  const requiredOpen = obligations.filter(
    ({ required, status }) => required && status !== "verified",
  );
  if (
    requiredOpen.some(
      ({ status, diagnostics }) =>
        status === "contradicted" ||
        hasDiagnostic(diagnostics, "verifier-failed"),
    )
  )
    return "failed";
  if (requiredOpen.some(({ status }) => status === "unknown")) return "unknown";
  return requiredOpen.length === 0 ? "ready" : "open";
};

export const obligationEdgeOrder = (
  left: { readonly obligation_id: string },
  right: { readonly obligation_id: string },
): number =>
  compareUnicodeCodePoints(canonicalJson(left), canonicalJson(right));

export const digestObligationLedgerValue = (value: unknown): string => {
  const encoded = canonicalize(value);
  if (encoded === undefined)
    throw new TypeError(
      "Reconstruction obligation ledger is not canonical JSON",
    );
  return createHash("sha256").update(encoded).digest("hex");
};

const countBy = <Value extends string, Item>(
  items: readonly Item[],
  values: readonly Value[],
  valueFor: (item: Item) => Value,
): { key: Value; count: number }[] =>
  values.map((value) => ({
    key: value,
    count: items.filter((item) => valueFor(item) === value).length,
  }));

const obligationIdsWith = (
  obligations: readonly ReconstructionObligation[],
  code: DiagnosticCode,
): string[] =>
  obligations
    .filter(({ diagnostics }) => hasDiagnostic(diagnostics, code))
    .map(({ obligation_id: id }) => id)
    .sort();

const hasDiagnostic = (
  diagnostics: ReconstructionObligation["diagnostics"],
  code: DiagnosticCode,
): boolean => diagnostics.some((diagnostic) => diagnostic.code === code);
