import {
  computeEvidenceId,
  parseEvidence,
  redactEvidence,
  type Evidence,
} from "./evidence.js";
import { jsonObjectSchema } from "./jsonValue.js";
import type { ResolvedLogicalPathConfig } from "./logicalPath.js";
import {
  mappedUnknownIdentity,
  mapUnknownRevision,
  parseUnknownMutationInput,
  mapUnknownMutationInput,
  type ResidualUnknown,
} from "./residualUnknown.js";

/** Re-key the authenticated record/unknown identity graph before rebuilding a bundle. */
export const mapEvidenceIdentityGraph = (
  authenticated: {
    readonly records: readonly Evidence[];
    readonly unknowns: readonly ResidualUnknown[];
  },
  config: ResolvedLogicalPathConfig,
): { records: Evidence[]; unknowns: ResidualUnknown[] } => {
  const byId = new Map(
    authenticated.records.map((record) => [record.evidence_id, record]),
  );
  const unknownById = new Map(
    authenticated.unknowns.map((unknown) => [unknown.unknown_id, unknown]),
  );
  const rewritten = new Map<string, Evidence>();
  const identities = new Map<string, string>();
  const active = new Set<string>();
  const isMutation = (record: Evidence) =>
    record.provider.id === "rea-unknown-registry" &&
    record.predicate_type === "rea.residual-unknown-mutation" &&
    (record.operation === "record_unknown" ||
      record.operation === "update_unknown");
  const evidenceId = (id: string) => rewritten.get(id)?.evidence_id ?? id;
  const unknownId = (id: string) => identities.get(id) ?? id;
  const dependencies = (key: string): string[] => {
    if (key.startsWith("u:")) {
      const scope = unknownById.get(key.slice(2))?.comparison_conclusion_scope;
      return scope === undefined ? [] : [`e:${scope.comparison_evidence_id}`];
    }
    const record = byId.get(key.slice(2));
    if (record === undefined) return [];
    const output = record.evidence_links.map((id) => `e:${id}`);
    if (!isMutation(record)) return output;
    const input = parseUnknownMutationInput(
      record.operation,
      record.parameters,
    );
    output.push(...input.supporting_evidence_ids.map((id) => `e:${id}`));
    output.push(...input.contradicting_evidence_ids.map((id) => `e:${id}`));
    output.push(
      ...input.relationships.map(({ unknown_id }) => `u:${unknown_id}`),
    );
    if ("unknown_id" in input) output.push(`u:${input.unknown_id}`);
    if (
      "comparison_conclusion_scope" in input &&
      input.comparison_conclusion_scope !== undefined
    )
      output.push(
        `e:${input.comparison_conclusion_scope.comparison_evidence_id}`,
      );
    if ("resolution" in input && input.resolution !== null)
      output.push(...input.resolution.evidence_ids.map((id) => `e:${id}`));
    return output;
  };
  const done = (key: string) =>
    key.startsWith("u:")
      ? !unknownById.has(key.slice(2)) || identities.has(key.slice(2))
      : !byId.has(key.slice(2)) || rewritten.has(key.slice(2));
  for (const root of [
    ...authenticated.records.map((record) => `e:${record.evidence_id}`),
    ...authenticated.unknowns.map((unknown) => `u:${unknown.unknown_id}`),
  ]) {
    if (done(root)) continue;
    const pending = [{ key: root, dependencies: dependencies(root), next: 0 }];
    active.add(root);
    while (pending.length > 0) {
      const frame = pending[pending.length - 1]!;
      const next = frame.dependencies[frame.next++];
      if (next !== undefined) {
        if (done(next)) continue;
        if (active.has(next))
          throw new TypeError(
            "Evidence and Unknown identity dependencies contain a cycle",
          );
        active.add(next);
        pending.push({ key: next, dependencies: dependencies(next), next: 0 });
        continue;
      }
      const id = frame.key.slice(2);
      if (frame.key.startsWith("u:")) {
        identities.set(
          id,
          mappedUnknownIdentity(unknownById.get(id)!, config, evidenceId),
        );
      } else {
        const source = byId.get(id)!;
        const redacted = redactEvidence(source, config);
        const links = redacted.evidence_links.map(evidenceId);
        const parameters = isMutation(source)
          ? jsonObjectSchema.parse(
              mapUnknownMutationInput(
                parseUnknownMutationInput(
                  source.operation,
                  redacted.parameters,
                ),
                evidenceId,
                unknownId,
              ),
            )
          : redacted.parameters;
        const { evidence_id: _id, ...value } = redacted;
        const updated = { ...value, parameters, evidence_links: links };
        rewritten.set(
          id,
          parseEvidence({
            ...updated,
            evidence_id: computeEvidenceId(updated),
          }),
        );
      }
      active.delete(frame.key);
      pending.pop();
    }
  }
  const histories = new Map<string, ResidualUnknown[]>();
  for (const unknown of authenticated.unknowns) {
    const history = histories.get(unknown.unknown_id) ?? [];
    history.push(unknown);
    histories.set(unknown.unknown_id, history);
  }
  const unknowns: ResidualUnknown[] = [];
  for (const history of histories.values()) {
    let previous: string | null = null;
    for (const unknown of history.sort((a, b) => a.revision - b.revision)) {
      const mapped = mapUnknownRevision(
        unknown,
        config,
        evidenceId,
        unknownId,
        previous,
      );
      unknowns.push(mapped);
      previous = mapped.revision_digest;
    }
  }
  return {
    records: authenticated.records.map((record) =>
      rewritten.get(record.evidence_id)!,
    ),
    unknowns,
  };
};
