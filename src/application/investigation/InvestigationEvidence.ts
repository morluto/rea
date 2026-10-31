import { resolveEvidenceInput } from "../EvidenceInputResolver.js";
import type { EvidenceReader } from "./InvestigationRecordPort.js";
import { uniqueSorted } from "../../domain/canonicalOrdering.js";
import {
  EvidenceReferenceError,
  type EvidenceIntegrityError,
} from "../../domain/evidenceErrors.js";
import { err, ok, type Result } from "../../domain/result.js";

/**
 * Follow exact session references without exporting unrelated records or
 * Unknowns. `inlineIds` names records the caller already supplied inline; a
 * missing one still fails closed, but is reported as a missing retained
 * closure rather than as a reference that inline input could repair.
 */
export const resolveInvestigationEvidenceClosure = (
  reader: Pick<EvidenceReader, "evidenceForAnalysis">,
  seedIds: readonly string[],
  inlineIds: ReadonlySet<string> = new Set(),
): Result<string[], EvidenceIntegrityError> => {
  const lookup = reader.evidenceForAnalysis.bind(reader);
  const resolve = (evidenceId: string) =>
    resolveEvidenceInput(
      { kind: "retained-evidence", evidence_id: evidenceId },
      lookup,
      "retained-closure",
    );
  // Check the caller's inline roots before following any links, so a missing
  // inline root is reported the same way whatever order its ID sorts in.
  for (const evidenceId of uniqueSorted(
    seedIds.filter((id) => inlineIds.has(id)),
  )) {
    const evidence = resolve(evidenceId);
    if (!evidence.ok && evidence.error.reason === "missing")
      return err(
        new EvidenceReferenceError(evidenceId, "missing", {
          expected: evidence.error.expected,
          actual: evidence.error.actual,
          referenceScope: "retained-closure",
          suppliedInline: true,
        }),
      );
  }
  const visited = new Set<string>();
  const pending = [...seedIds];
  while (pending.length > 0) {
    const evidenceId = pending.pop();
    if (evidenceId === undefined || visited.has(evidenceId)) continue;
    const evidence = resolve(evidenceId);
    if (!evidence.ok) return evidence;
    visited.add(evidenceId);
    pending.push(...evidence.value.evidence_links);
  }
  return ok(uniqueSorted([...visited]));
};
