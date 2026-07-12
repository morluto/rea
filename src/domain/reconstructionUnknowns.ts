import type {
  ReconstructionClaim,
  ReconstructionClaimResult,
  ReconstructionVerificationResult,
} from "./reconstructionVerificationSchemas.js";
import type { ResidualUnknown } from "./residualUnknown.js";

/** Select the latest revision of each residual unknown. */
export const reconstructionUnknownHeads = (
  revisions: readonly ResidualUnknown[],
): ReadonlyMap<string, ResidualUnknown> => {
  const heads = new Map<string, ResidualUnknown>();
  for (const item of revisions) {
    const current = heads.get(item.unknown_id);
    if (current === undefined || current.revision < item.revision)
      heads.set(item.unknown_id, item);
  }
  return heads;
};

/** Find active unknowns that affect a comparison or one of its sources. */
export const reconstructionClaimUnknowns = (
  heads: ReadonlyMap<string, ResidualUnknown>,
  comparisonId: string,
  sourceIds: readonly string[],
): ResidualUnknown[] => {
  const evidenceIds = new Set([comparisonId, ...sourceIds]);
  const relevantIds = new Set(
    [...heads.values()]
      .filter(
        (item) =>
          item.status !== "resolved" &&
          [
            ...item.supporting_evidence_ids,
            ...item.contradicting_evidence_ids,
          ].some((id) => evidenceIds.has(id)),
      )
      .map(({ unknown_id: id }) => id),
  );
  const pending = [...relevantIds];
  while (pending.length > 0) {
    const currentId = pending.pop();
    if (currentId === undefined) continue;
    const current = heads.get(currentId);
    if (current === undefined) continue;
    for (const relationship of current.relationships) {
      if (relationship.type === "related-to") continue;
      const dependency = heads.get(relationship.unknown_id);
      if (
        dependency === undefined ||
        dependency.status === "resolved" ||
        relevantIds.has(dependency.unknown_id)
      )
        continue;
      relevantIds.add(dependency.unknown_id);
      pending.push(dependency.unknown_id);
    }
  }
  return [...relevantIds]
    .flatMap((id) => {
      const unknown = heads.get(id);
      return unknown === undefined ? [] : [unknown];
    })
    .sort((left, right) =>
      left.unknown_id.localeCompare(right.unknown_id, "en"),
    );
};

/** Aggregate and bound deterministic probes for unresolved claims. */
export const reconstructionProbes = (
  results: readonly ReconstructionClaimResult[],
  heads: ReadonlyMap<string, ResidualUnknown>,
): {
  readonly items: ReconstructionVerificationResult["recommended_probes"];
  readonly truncated: boolean;
} => {
  const output = new Map<
    string,
    {
      operation: string;
      rationale: string;
      claim_ids: string[];
      unknown_ids: string[];
    }
  >();
  for (const result of results.filter(({ status }) => status === "unknown")) {
    const unknowns = result.unknown_ids.flatMap((id) => {
      const item = heads.get(id);
      return item === undefined ? [] : [item];
    });
    const probes = unknowns.flatMap(({ recommended_probes: items }) => items);
    const candidates = probes.length > 0 ? probes : [defaultProbe(result.kind)];
    for (const probe of candidates) {
      const key = `${probe.operation}\0${probe.rationale}`;
      const current = output.get(key) ?? {
        ...probe,
        claim_ids: [],
        unknown_ids: [],
      };
      current.claim_ids = uniqueSorted([...current.claim_ids, result.claim_id]);
      current.unknown_ids = uniqueSorted([
        ...current.unknown_ids,
        ...result.unknown_ids,
      ]);
      output.set(key, current);
    }
  }
  const sorted = [...output.values()].sort((left, right) =>
    `${left.operation}\0${left.rationale}`.localeCompare(
      `${right.operation}\0${right.rationale}`,
      "en",
    ),
  );
  return { items: sorted.slice(0, 2_000), truncated: sorted.length > 2_000 };
};

const defaultProbe = (
  kind: ReconstructionClaim["kind"],
): { operation: string; rationale: string } =>
  kind === "behavioral"
    ? {
        operation: "capture_process_scenario",
        rationale: "Repeat both scenarios under one controlled environment.",
      }
    : kind === "structural-function"
      ? {
          operation: "analyze_function",
          rationale: "Capture complete function dossiers under equal limits.",
        }
      : {
          operation: "inventory_artifact",
          rationale:
            "Capture complete artifact inventories under equal limits.",
        };

const uniqueSorted = (values: readonly string[]): string[] =>
  [...new Set(values)].sort((left, right) => left.localeCompare(right, "en"));
