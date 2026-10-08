import { z } from "zod";
import canonicalize from "canonicalize";

import {
  evidenceEnvelopeSchema,
  evidenceRecordSchema,
  immutableEvidence,
  parseEvidence,
  providerSchema,
  type Evidence,
} from "./evidence.js";
import {
  residualUnknownSchema,
  type ResidualUnknown,
} from "./residualUnknown.js";
import { freezeJsonSnapshot } from "./immutableJson.js";

const artifactManifestSchema = evidenceEnvelopeSchema.shape.subject
  .unwrap()
  .pick({
    digest: true,
    format: true,
    architecture: true,
  });
const providerManifestSchema = providerSchema;
const environmentManifestSchema =
  evidenceEnvelopeSchema.shape.environment.unwrap();
const scenarioManifestSchema = z.object({
  evidence_id: evidenceEnvelopeSchema.shape.evidence_id,
  operation: z.string().min(1),
  authority: z.literal("controlled-replay"),
});
const captureManifestSchema = z.object({
  evidence_id: evidenceEnvelopeSchema.shape.evidence_id,
  predicate_type: z.string().min(1),
});

export const evidenceBundleSchema = z.object({
  artifacts: z.array(artifactManifestSchema),
  providers: z.array(providerManifestSchema),
  environments: z.array(environmentManifestSchema),
  scenarios: z.array(scenarioManifestSchema),
  captures: z.array(captureManifestSchema),
  unknowns: z.array(residualUnknownSchema),
  records: z.array(evidenceRecordSchema),
});

export type EvidenceBundle = z.infer<typeof evidenceBundleSchema>;
const immutableBundles = new WeakMap<object, EvidenceBundle>();

/** Build and authenticate a sealed bundle while reusing immutable Evidence records. */
export const createImmutableEvidenceBundle = (
  records: readonly Evidence[],
  unknowns: readonly ResidualUnknown[] = [],
): EvidenceBundle => {
  const checkedRecords = records.map(immutableEvidence);
  if (
    new Set(checkedRecords.map(({ evidence_id }) => evidence_id)).size !==
    checkedRecords.length
  )
    throw new TypeError("Evidence bundle contains duplicate record IDs");
  const checkedUnknowns = unknowns.map((unknown) =>
    residualUnknownSchema.parse(unknown),
  );
  validateUnknownGraph(checkedUnknowns, checkedRecords);
  const bundle = freezeJsonSnapshot(
    createEvidenceBundle(checkedRecords, checkedUnknowns),
  );
  immutableBundles.set(bundle, bundle);
  return bundle;
};

/** Project records into a deterministic bundle whose order has no semantics. */
export const createEvidenceBundle = (
  records: readonly Evidence[],
  unknowns: readonly ResidualUnknown[] = [],
): EvidenceBundle => {
  const sortedRecords = [...records].sort((left, right) =>
    left.evidence_id.localeCompare(right.evidence_id),
  );
  return {
    artifacts: uniqueSorted(
      sortedRecords.flatMap(({ subject }) =>
        subject === null
          ? []
          : [
              {
                digest: subject.digest,
                format: subject.format,
                architecture: subject.architecture,
              },
            ],
      ),
    ),
    providers: uniqueSorted(sortedRecords.map(({ provider }) => provider)),
    environments: uniqueSorted(
      sortedRecords.flatMap(({ environment }) =>
        environment === null ? [] : [environment],
      ),
    ),
    scenarios: sortedRecords.flatMap((evidence) =>
      evidence.authority === "controlled-replay"
        ? [
            {
              evidence_id: evidence.evidence_id,
              operation: evidence.operation,
              authority: evidence.authority,
            },
          ]
        : [],
    ),
    captures: sortedRecords.flatMap((evidence) =>
      evidence.predicate_type === "rea.process-capture"
        ? [
            {
              evidence_id: evidence.evidence_id,
              predicate_type: evidence.predicate_type,
            },
          ]
        : [],
    ),
    unknowns: [...unknowns].sort(
      (left, right) =>
        left.unknown_id.localeCompare(right.unknown_id) ||
        left.revision - right.revision,
    ),
    records: sortedRecords,
  };
};

/** Restrict a bundle to records and complete unknown histories for one artifact. */
export const evidenceBundleForTarget = (
  bundle: EvidenceBundle,
  sha256: string,
): EvidenceBundle => {
  const recordsById = new Map(
    bundle.records.map((record) => [record.evidence_id, record]),
  );
  const candidates = bundle.unknowns.filter(
    ({ scope_digest: scopeDigest }) => scopeDigest === sha256,
  );
  const retained = new Set<ResidualUnknown>();
  const revisionsById = new Map<string, number>();
  const dependents = new Map<string, Set<ResidualUnknown>>();
  for (const unknown of candidates) {
    const mutationEvidenceIds = new Set(unknown.mutation_evidence_ids);
    const evidenceAvailable = referencedEvidenceIds(unknown).every((id) => {
      const record = recordsById.get(id);
      return (
        record?.subject?.digest.sha256 === sha256 ||
        (mutationEvidenceIds.has(id) &&
          record?.subject === null &&
          record.predicate_type === "rea.residual-unknown-mutation")
      );
    });
    if (!evidenceAvailable) continue;
    retained.add(unknown);
    revisionsById.set(
      unknown.unknown_id,
      (revisionsById.get(unknown.unknown_id) ?? 0) + 1,
    );
    for (const relatedId of new Set(
      unknown.relationships.map(({ unknown_id: id }) => id),
    )) {
      const references =
        dependents.get(relatedId) ?? new Set<ResidualUnknown>();
      references.add(unknown);
      dependents.set(relatedId, references);
    }
  }
  const pending: ResidualUnknown[] = [];
  for (const unknown of retained)
    if (
      unknown.relationships.some(({ unknown_id: id }) => !revisionsById.has(id))
    )
      pending.push(unknown);
  for (let index = 0; index < pending.length; index += 1) {
    const unknown = pending[index];
    if (unknown === undefined || !retained.delete(unknown)) continue;
    const remaining = (revisionsById.get(unknown.unknown_id) ?? 1) - 1;
    if (remaining > 0) {
      revisionsById.set(unknown.unknown_id, remaining);
      continue;
    }
    revisionsById.delete(unknown.unknown_id);
    for (const dependent of dependents.get(unknown.unknown_id) ?? [])
      pending.push(dependent);
  }
  const unknowns = candidates.filter((unknown) => retained.has(unknown));
  const mutationIds = new Set(
    unknowns.flatMap(({ mutation_evidence_ids: ids }) => ids),
  );
  return createEvidenceBundle(
    bundle.records.filter(
      (record) =>
        record.subject?.digest.sha256 === sha256 ||
        mutationIds.has(record.evidence_id),
    ),
    unknowns,
  );
};

const referencedEvidenceIds = (unknown: ResidualUnknown): readonly string[] => [
  ...unknown.supporting_evidence_ids,
  ...unknown.contradicting_evidence_ids,
  ...unknown.mutation_evidence_ids,
  ...(unknown.resolution?.evidence_ids ?? []),
];

/** Parse records, verify semantic IDs, and reject inconsistent manifests. */
export const parseEvidenceBundle = (input: unknown): EvidenceBundle => {
  if (typeof input === "object" && input !== null) {
    const owned = immutableBundles.get(input);
    if (owned !== undefined) return owned;
  }
  const parsed = evidenceBundleSchema.parse(input);
  const recordIds = parsed.records.map(({ evidence_id: id }) => id);
  if (new Set(recordIds).size !== recordIds.length)
    throw new TypeError("Evidence bundle contains duplicate record IDs");
  validateUnknownGraph(parsed.unknowns, parsed.records);
  const canonical = createEvidenceBundle(
    parsed.records.map(parseEvidence),
    parsed.unknowns,
  );
  if (JSON.stringify(parsed) !== JSON.stringify(canonical))
    throw new TypeError("Evidence bundle manifests are not canonical");
  return canonical;
};

const validateUnknownGraph = (
  unknowns: readonly ResidualUnknown[],
  records: readonly Evidence[],
): void => {
  const evidenceById = new Map(
    records.map((record) => [record.evidence_id, record]),
  );
  const histories = new Map<string, ResidualUnknown[]>();
  for (const unknown of unknowns) {
    const history = histories.get(unknown.unknown_id) ?? [];
    history.push(unknown);
    histories.set(unknown.unknown_id, history);
  }
  const unknownById = new Map<string, ResidualUnknown>();
  for (const [id, unordered] of histories) {
    const history = [...unordered].sort(
      (left, right) => left.revision - right.revision,
    );
    for (const [index, revision] of history.entries()) {
      if (revision.revision !== index + 1)
        throw new TypeError(
          `Residual unknown ${id} revision history has a gap`,
        );
      if (
        index > 0 &&
        revision.previous_revision_digest !==
          history[index - 1]?.revision_digest
      )
        throw new TypeError(`Residual unknown ${id} revision chain is broken`);
    }
    const head = history.at(-1);
    if (head === undefined)
      throw new TypeError("Residual unknown revision history is empty");
    unknownById.set(id, head);
  }
  for (const unknown of unknowns) {
    const referencedEvidence = [
      ...unknown.supporting_evidence_ids,
      ...unknown.contradicting_evidence_ids,
      ...unknown.mutation_evidence_ids,
      ...(unknown.resolution?.evidence_ids ?? []),
    ];
    for (const evidenceId of referencedEvidence)
      if (!evidenceById.has(evidenceId))
        throw new TypeError(
          `Residual unknown references missing evidence ${evidenceId}`,
        );
    for (const relationship of unknown.relationships)
      if (!unknownById.has(relationship.unknown_id))
        throw new TypeError(
          `Residual unknown references missing unknown ${relationship.unknown_id}`,
        );
    if (unknown.resolution?.disposition === "verified")
      validateVerifiedResolution(unknown, evidenceById);
  }
  rejectDependencyCycles(unknownById);
};

const validateVerifiedResolution = (
  unknown: ResidualUnknown,
  evidenceById: Pick<ReadonlyMap<string, Evidence>, "get">,
): void => {
  if (unknown.contradicting_evidence_ids.length > 0)
    throw new TypeError(
      `Residual unknown ${unknown.unknown_id} retains contradicting evidence`,
    );
  const qualifies = unknown.resolution?.evidence_ids.some((evidenceId) => {
    const evidence = evidenceById.get(evidenceId);
    return (
      unknown.supporting_evidence_ids.includes(evidenceId) &&
      evidence !== undefined &&
      evidence.predicate_type !== "rea.residual-unknown-mutation" &&
      evidenceQualifies(unknown, evidence)
    );
  });
  if (qualifies !== true)
    throw new TypeError(
      `Residual unknown ${unknown.unknown_id} has no qualifying resolution evidence`,
    );
};

/**
 * Validate one new residual-unknown revision against an already valid ledger.
 * This keeps ordinary mutations proportional to the affected revision while
 * full bundle imports continue to validate the complete graph.
 */
export const validateResidualUnknownAddition = (
  unknown: ResidualUnknown,
  evidenceById: Pick<ReadonlyMap<string, Evidence>, "get" | "has">,
  currentHeads: ReadonlyMap<string, ResidualUnknown>,
): void => {
  const current = currentHeads.get(unknown.unknown_id);
  if (
    current === undefined
      ? unknown.revision !== 1 || unknown.previous_revision_digest !== null
      : unknown.revision !== current.revision + 1 ||
        unknown.previous_revision_digest !== current.revision_digest
  )
    throw new TypeError(
      `Residual unknown ${unknown.unknown_id} revision chain is broken`,
    );
  for (const evidenceId of referencedEvidenceIds(unknown))
    if (!evidenceById.has(evidenceId))
      throw new TypeError(
        `Residual unknown references missing evidence ${evidenceId}`,
      );
  for (const relationship of unknown.relationships)
    if (
      relationship.unknown_id !== unknown.unknown_id &&
      !currentHeads.has(relationship.unknown_id)
    )
      throw new TypeError(
        `Residual unknown references missing unknown ${relationship.unknown_id}`,
      );
  if (unknown.resolution?.disposition === "verified")
    validateVerifiedResolution(unknown, evidenceById);
  // In a valid graph, no existing node can point to an absent ID. Since the
  // schema rejects self-relations, a new node's outgoing edges cannot close a
  // cycle; keep graph traversal for revisions of existing nodes only.
  if (current !== undefined) {
    const dependencies = unknown.relationships
      .filter((relationship) => relationship.type === "depends-on")
      .map(({ unknown_id }) => unknown_id);
    if (
      dependencies.length > 0 &&
      reachesUnknown(dependencies, unknown.unknown_id, currentHeads, unknown)
    )
      throw new TypeError("Residual unknown dependency graph contains a cycle");
  }
};

const reachesUnknown = (
  starts: readonly string[],
  goal: string,
  currentHeads: ReadonlyMap<string, ResidualUnknown>,
  candidate: ResidualUnknown,
): boolean => {
  const pending = [...starts];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const id = pending.pop();
    if (id === undefined) break;
    if (id === goal) return true;
    if (visited.has(id)) continue;
    visited.add(id);
    const unknown =
      id === candidate.unknown_id ? candidate : currentHeads.get(id);
    if (unknown === undefined) continue;
    for (const relationship of unknown.relationships)
      if (relationship.type === "depends-on")
        pending.push(relationship.unknown_id);
  }
  return false;
};

const evidenceQualifies = (
  unknown: ResidualUnknown,
  evidence: Evidence,
): boolean => {
  if (
    unknown.required_authority !== null &&
    evidence.authority !== unknown.required_authority
  )
    return false;
  const confidenceRank = { inferred: 1, derived: 2, observed: 3 } as const;
  if (
    confidenceRank[evidence.confidence] <
    confidenceRank[unknown.required_confidence]
  )
    return false;
  const requirement = unknown.required_environment;
  if (requirement === null) return true;
  if (evidence.environment === null) return false;
  return (
    (requirement.id === null || requirement.id === evidence.environment.id) &&
    (requirement.platform === null ||
      requirement.platform === evidence.environment.platform) &&
    (requirement.architecture === null ||
      requirement.architecture === evidence.environment.architecture) &&
    (requirement.isolation === null ||
      requirement.isolation === evidence.environment.isolation)
  );
};

const rejectDependencyCycles = (
  unknownById: ReadonlyMap<string, ResidualUnknown>,
): void => {
  const visited = new Set<string>();
  const active = new Set<string>();
  const pending: {
    readonly id: string;
    readonly relationships: ResidualUnknown["relationships"];
    nextRelationship: number;
  }[] = [];
  for (const root of unknownById.keys()) {
    if (visited.has(root)) continue;
    const rootUnknown = unknownById.get(root);
    if (rootUnknown === undefined)
      throw new TypeError("Residual unknown dependency graph is inconsistent");
    active.add(root);
    pending.push({
      id: root,
      relationships: rootUnknown.relationships,
      nextRelationship: 0,
    });
    while (pending.length > 0) {
      const frame = pending[pending.length - 1];
      if (frame === undefined) break;
      let descended = false;
      while (frame.nextRelationship < frame.relationships.length) {
        const relationship = frame.relationships[frame.nextRelationship];
        frame.nextRelationship += 1;
        if (relationship?.type !== "depends-on") continue;
        const dependency = relationship.unknown_id;
        if (active.has(dependency))
          throw new TypeError(
            "Residual unknown dependency graph contains a cycle",
          );
        if (visited.has(dependency)) continue;
        const unknown = unknownById.get(dependency);
        if (unknown === undefined)
          throw new TypeError(
            "Residual unknown dependency graph is inconsistent",
          );
        active.add(dependency);
        pending.push({
          id: dependency,
          relationships: unknown.relationships,
          nextRelationship: 0,
        });
        descended = true;
        break;
      }
      if (descended) continue;
      pending.pop();
      active.delete(frame.id);
      visited.add(frame.id);
    }
  }
};

/** Encode a validated bundle as byte-stable RFC 8785 canonical JSON. */
export const serializeEvidenceBundle = (bundle: EvidenceBundle): string => {
  const serialized = canonicalize(parseEvidenceBundle(bundle));
  if (serialized === undefined)
    throw new TypeError("Evidence bundle canonicalization failed");
  return serialized;
};

const uniqueSorted = <Value>(values: readonly Value[]): Value[] => {
  const unique = new Map<string, Value>();
  for (const value of values) unique.set(JSON.stringify(value), value);
  return [...unique.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, value]) => value);
};
