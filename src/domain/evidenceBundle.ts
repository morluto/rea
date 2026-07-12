import { z } from "zod";
import canonicalize from "canonicalize";

import { evidenceSchema, parseEvidence, type Evidence } from "./evidence.js";
import {
  residualUnknownSchema,
  type ResidualUnknown,
} from "./residualUnknown.js";

const artifactManifestSchema = evidenceSchema.shape.subject.unwrap().pick({
  digest: true,
  format: true,
  architecture: true,
});
const providerManifestSchema = evidenceSchema.shape.provider;
const environmentManifestSchema = evidenceSchema.shape.environment.unwrap();
const scenarioManifestSchema = z.object({
  evidence_id: evidenceSchema.shape.evidence_id,
  operation: z.string().min(1),
  authority: z.literal("controlled-replay"),
});
const captureManifestSchema = z.object({
  evidence_id: evidenceSchema.shape.evidence_id,
  predicate_type: z.string().min(1),
});

export const evidenceBundleSchema = z.object({
  bundle_version: z.literal(2),
  artifacts: z.array(artifactManifestSchema),
  providers: z.array(providerManifestSchema),
  environments: z.array(environmentManifestSchema),
  scenarios: z.array(scenarioManifestSchema),
  captures: z.array(captureManifestSchema),
  unknowns: z.array(residualUnknownSchema),
  records: z.array(evidenceSchema),
});

export type EvidenceBundle = z.infer<typeof evidenceBundleSchema>;

export interface EvidenceFilePolicy {
  readonly roots: readonly string[];
  readonly maxBytes: number;
  readonly maxDepth: number;
  readonly maxStringLength: number;
  readonly maxNodes: number;
}

/** Project records into a deterministic bundle whose order has no semantics. */
export const createEvidenceBundle = (
  records: readonly Evidence[],
  unknowns: readonly ResidualUnknown[] = [],
): EvidenceBundle => {
  const sortedRecords = [...records].sort((left, right) =>
    left.evidence_id.localeCompare(right.evidence_id),
  );
  return {
    bundle_version: 2,
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
      evidence.predicate_type.startsWith("rea.process-capture/")
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

/** Parse records, verify semantic IDs, and reject inconsistent manifests. */
export const parseEvidenceBundle = (input: unknown): EvidenceBundle => {
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
  evidenceById: ReadonlyMap<string, Evidence>,
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
      evidence.predicate_type !== "rea.residual-unknown-mutation/v1" &&
      evidenceQualifies(unknown, evidence)
    );
  });
  if (qualifies !== true)
    throw new TypeError(
      `Residual unknown ${unknown.unknown_id} has no qualifying resolution evidence`,
    );
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
  const visit = (id: string): void => {
    if (active.has(id))
      throw new TypeError("Residual unknown dependency graph contains a cycle");
    if (visited.has(id)) return;
    active.add(id);
    const unknown = unknownById.get(id);
    if (unknown === undefined)
      throw new TypeError("Residual unknown dependency graph is inconsistent");
    for (const relationship of unknown.relationships)
      if (relationship.type === "depends-on") visit(relationship.unknown_id);
    active.delete(id);
    visited.add(id);
  };
  for (const id of unknownById.keys()) visit(id);
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
