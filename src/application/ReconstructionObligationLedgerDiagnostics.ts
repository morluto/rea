import type {
  ReconstructionObligation,
  ReconstructionObligationManifest,
} from "../domain/reconstructionObligationLedgerSchemas.js";
import type { Evidence } from "../domain/evidence.js";
import { compareUnicodeCodePoints } from "../domain/unicodeCodePointOrder.js";

type Diagnostic = ReconstructionObligation["diagnostics"][number];
type Binding = NonNullable<ReconstructionObligation["binding"]>;

export const groupManifestBindings = (
  manifest: ReconstructionObligationManifest,
): ReadonlyMap<string, readonly Binding[]> => {
  const grouped = new Map<string, Binding[]>();
  for (const binding of manifest.bindings)
    grouped.set(binding.obligation_id, [
      ...(grouped.get(binding.obligation_id) ?? []),
      binding,
    ]);
  return grouped;
};

export const groupManifestContradictions = (
  manifest: ReconstructionObligationManifest,
): ReadonlyMap<string, readonly string[]> => {
  const grouped = new Map<string, string[]>();
  for (const contradiction of manifest.contradictions)
    grouped.set(contradiction.obligation_id, [
      ...(grouped.get(contradiction.obligation_id) ?? []),
      ...contradiction.evidence_ids,
    ]);
  return grouped;
};

export const addObligationDiagnostic = (
  diagnostics: Diagnostic[],
  code: Diagnostic["code"],
  detail: string,
): void => {
  diagnostics.push({ code, detail });
};

export const uniqueObligationDiagnostics = (
  diagnostics: readonly Diagnostic[],
): Diagnostic[] =>
  [
    ...new Map(
      diagnostics.map((diagnostic) => [
        `${diagnostic.code}:${diagnostic.detail}`,
        diagnostic,
      ]),
    ).values(),
  ].sort((left, right) =>
    compareUnicodeCodePoints(
      `${left.code}:${left.detail}`,
      `${right.code}:${right.detail}`,
    ),
  );

export const contradictionDiagnostics = (
  obligationId: string,
  contradictions: ReadonlyMap<string, readonly string[]>,
  evidenceById: ReadonlyMap<string, Evidence>,
): Diagnostic[] => {
  const evidenceIds = contradictions.get(obligationId) ?? [];
  if (evidenceIds.length === 0) return [];
  const missing = evidenceIds.filter(
    (evidenceId) => !evidenceById.has(evidenceId),
  );
  return missing.length > 0
    ? [
        {
          code: "contradiction-evidence-missing",
          detail: `Contradiction references missing Evidence: ${missing.join(", ")}.`,
        },
      ]
    : [
        {
          code: "contradiction",
          detail:
            "Authenticated contradictory Evidence reopens this obligation.",
        },
      ];
};
