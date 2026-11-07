import { resolveEvidenceInput } from "../EvidenceInputResolver.js";
import type { EvidenceReader } from "./InvestigationRecordPort.js";
import { uniqueSorted } from "../../domain/canonicalOrdering.js";
import type { EvidenceIntegrityError } from "../../domain/evidenceErrors.js";
import type { Evidence } from "../../domain/evidence.js";
import { ok, type Result } from "../../domain/result.js";

type Lookup = (id: string) => Evidence | undefined;

/** Traverse without expanding a wide link array into function arguments. */
const visitClosure = (
  lookup: Lookup,
  seedIds: readonly string[],
  knownComplete?: ReadonlySet<string>,
): Result<Set<string>, EvidenceIntegrityError> => {
  const visited = new Set<string>();
  const pending = [...seedIds];
  while (pending.length > 0) {
    const evidenceId = pending.pop();
    if (
      evidenceId === undefined ||
      visited.has(evidenceId) ||
      knownComplete?.has(evidenceId)
    )
      continue;
    const evidence = resolveEvidenceInput(
      { kind: "retained-evidence", evidence_id: evidenceId },
      lookup,
      "retained-closure",
    );
    if (!evidence.ok) return evidence;
    visited.add(evidenceId);
    for (const linkedId of evidence.value.evidence_links)
      pending.push(linkedId);
  }
  return ok(visited);
};

/** Follow exact session references without exporting unrelated records or Unknowns. */
export const resolveInvestigationEvidenceClosure = (
  reader: Pick<EvidenceReader, "evidenceForAnalysis">,
  seedIds: readonly string[],
  sources: readonly Evidence[] = [],
): Result<string[], EvidenceIntegrityError> => {
  // Supplied authenticated records are part of this investigation too. A
  // portable inline source need not already have been inserted in the ledger.
  const supplied = new Map(
    sources.map((source) => [source.evidence_id, source]),
  );
  const visited = visitClosure(
    (id) => supplied.get(id) ?? reader.evidenceForAnalysis(id),
    seedIds,
  );
  return visited.ok ? ok(uniqueSorted([...visited.value])) : visited;
};

/** Reuse closure decisions while the caller's lookup remains immutable. */
export const createInvestigationEvidenceClosureChecker = (
  reader: Pick<EvidenceReader, "evidenceForAnalysis">,
): ((seedIds: readonly string[]) => boolean) => {
  const complete = new Set<string>();
  const incomplete = new Set<string>();
  return (seedIds) => {
    const single = seedIds.length === 1 ? seedIds[0] : undefined;
    if (single !== undefined && incomplete.has(single)) return false;
    const visited = visitClosure(
      (id) => reader.evidenceForAnalysis(id),
      seedIds,
      complete,
    );
    if (!visited.ok) {
      if (single !== undefined) incomplete.add(single);
      return false;
    }
    for (const id of visited.value) complete.add(id);
    return true;
  };
};
