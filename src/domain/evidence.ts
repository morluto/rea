import { isDeepStrictEqual } from "node:util";
import { basename } from "node:path";
import { z } from "zod";

import { withEvidenceSubjectDeclaration } from "./evidenceSubject.js";

import { digestCanonicalValue } from "./canonicalDigest.js";
import { canonicalJsonDigestSteps } from "./canonicalJsonDigestSteps.js";
import { nulFreeStringSchema } from "./localPath.js";

import {
  DEFAULT_LOGICAL_ROOT_PREFIX,
  normalizeLogicalPath,
  normalizeLogicalPrefix,
  redactEvidenceObservationPathsSteps,
  type LogicalPathRootMapping,
  type LogicalPathFields,
} from "./logicalPathRoot.js";
import {
  analysisProfileSchema,
  type AnalysisProfileCommitment,
} from "./analysisProfile.js";
import type { BinaryArchitecture, BinaryTarget } from "./binaryTargetTypes.js";
import {
  jsonObjectSchema,
  jsonValueSchema,
  jsonValueValidationIssue,
  jsonValueValidationSteps,
  type JsonValue,
} from "./jsonValue.js";
import {
  freezeJsonSnapshot,
  freezeOwnedJsonTreeSnapshot,
  canBorrowParsedJsonSnapshot,
  immutableJsonSnapshotMember,
  isImmutableJsonSnapshot,
} from "./immutableJson.js";
import { digestSchema, prefixedDigestSchema } from "./../domain/digests.js";
import {
  relationshipCoverageSchema,
  type RelationshipCoverage,
} from "./relationshipCoverage.js";

/** Predicate shared by ordinary provider analysis observations. */
export const ANALYSIS_EVIDENCE_PREDICATE = "rea.analysis";

/** Provider identity schema shared by evidence-bearing persistence formats. */
export const providerSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().nullable(),
});
const subjectBaseSchema = z.strictObject({
  name: z.string().min(1),
  digest: z.strictObject({ sha256: digestSchema }),
  local_path: nulFreeStringSchema,
});
const subjectSchema = withEvidenceSubjectDeclaration(subjectBaseSchema);
/** Source location attached to an evidence observation. */
/** Source-location schema shared by evidence-bearing persistence formats. */
export const evidenceLocationSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("address"), address: z.string().min(1) }),
  z.strictObject({
    kind: z.literal("address-range"),
    start: z.string().min(1),
    end: z.string().min(1),
  }),
  z.strictObject({ kind: z.literal("artifact-path"), path: z.string().min(1) }),
  z.strictObject({
    kind: z.literal("file-offset"),
    offset: z.int().min(0),
  }),
  z.strictObject({
    kind: z.literal("file-offset-range"),
    start: z.int().min(0),
    end: z.int().min(0),
  }),
]);

/** Source authority vocabulary owned by Evidence and reused by its consumers. */
export const evidenceAuthoritySchema = z.enum([
  "shipped-artifact",
  "controlled-replay",
  "historical-reference",
  "external-service",
  "analyst-inference",
]);

const executionEnvironmentSchema = z.strictObject({
  id: z.string().min(1),
  platform: z.string().min(1),
  architecture: z.string().min(1),
  isolation: z.enum(["none", "process", "container", "virtual-machine"]),
});
const callerInputPathsSchema = z.record(
  nulFreeStringSchema,
  nulFreeStringSchema,
);

const evidenceBaseSchema = z
  .object({
    evidence_id: prefixedDigestSchema("ev"),
    subject: subjectSchema.nullable(),
    provider: providerSchema,
    analysis_profile: analysisProfileSchema.nullable(),
    predicate_type: z.string().min(1),
    operation: z.string().min(1),
    parameters: jsonObjectSchema,
    /** Verbatim selected path for a direct request; absent on older records. */
    caller_input_path: nulFreeStringSchema
      .exactOptional()
      .describe("Verbatim direct-request path; not part of semantic identity."),
    caller_input_paths: callerInputPathsSchema
      .exactOptional()
      .describe(
        "Verbatim auxiliary input paths keyed by argument name; caller assertions outside semantic identity.",
      ),
    raw_result: jsonValueSchema.nullable(),
    normalized_result: jsonValueSchema,
    confidence: z.enum(["observed", "derived", "inferred"]),
    authority: evidenceAuthoritySchema,
    environment: executionEnvironmentSchema.nullable(),
    limitations: z.array(z.string()),
    relationship_coverage: relationshipCoverageSchema.nullable(),
    locations: z.array(evidenceLocationSchema),
    evidence_links: z.array(prefixedDigestSchema("ev")),
  })
  .strict();

/** Require a reported analysis profile to identify the observation provider. */
export const validateAnalysisProfileProvider = (
  evidence: Pick<
    z.infer<typeof evidenceBaseSchema>,
    "analysis_profile" | "provider"
  >,
  context: z.RefinementCtx,
): void => {
  const profile = evidence.analysis_profile;
  if (
    profile !== null &&
    (profile.provider.id !== evidence.provider.id ||
      profile.provider.name !== evidence.provider.name ||
      profile.provider.version !== evidence.provider.version)
  )
    context.addIssue({
      code: "custom",
      path: ["analysis_profile", "provider"],
      message: "Analysis profile provider does not match Evidence provider",
    });
};

/** Strict, provider-neutral record for one successful public observation. */
export const evidenceSchema = evidenceBaseSchema.superRefine(
  validateAnalysisProfileProvider,
);

const authenticatedEvidenceSchema = evidenceSchema.superRefine(
  (evidence, context) => {
    const { evidence_id: evidenceId, ...withoutId } = evidence;
    if (computeEvidenceId(withoutId) !== evidenceId)
      context.addIssue({
        code: "custom",
        path: ["evidence_id"],
        message: usesPre66NullCoverageIdentity(withoutId, evidenceId)
          ? "Evidence uses an earlier relationship_coverage identity commitment: explicit null was omitted from that digest. Recreate this observation with the current REA release; re-exporting the old bundle cannot update its identity."
          : "Evidence semantic identifier does not match its record",
      });
  },
);

/** Complete observation whose normalized payload retains its operation-specific type. */
type EvidenceSchemaValue = z.infer<typeof evidenceSchema>;
export type Evidence<Result extends JsonValue = JsonValue> =
  EvidenceSchemaValue & {
    readonly normalized_result: Result;
  };
const immutableEvidenceSnapshots = new WeakMap<object, Evidence>();
const immutableResultSchema = z
  .custom<JsonValue>(isImmutableJsonSnapshot)
  .superRefine((value, context) => {
    const issue = jsonValueValidationIssue(value);
    if (issue !== undefined)
      context.addIssue({ code: "custom", message: issue });
  });
export type EvidenceLocation = z.infer<typeof evidenceLocationSchema>;

/** Candidate local artifact identity validated by the Evidence subject schema. */
export interface EvidenceSubjectTarget {
  readonly path: string;
  readonly sha256: string;
  readonly format: z.infer<typeof subjectSchema>["format"];
  readonly architecture?: BinaryArchitecture;
}

/** Rebind a matching immutable artifact subject to the caller's selected path. */
export const rebindEvidenceSubjectTargetPath = (
  subject: EvidenceSubjectTarget,
  target: EvidenceSubjectTarget,
): EvidenceSubjectTarget =>
  subject.sha256 === target.sha256 &&
  subject.format === target.format &&
  (subject.architecture ?? null) === (target.architecture ?? null)
    ? { ...subject, path: target.path }
    : subject;

type EvidenceAuthority = z.infer<typeof evidenceAuthoritySchema>;
type ExecutionEnvironment = z.infer<typeof executionEnvironmentSchema>;

export type EvidenceProvider = Readonly<z.output<typeof providerSchema>>;

/** Payloads admitted and snapshotted by the ordinary Evidence constructor. */
export interface EvidenceObservationInput {
  readonly predicateType?: string;
  readonly operation: string;
  readonly parameters: unknown;
  readonly result: unknown;
  /** Producer-owned filesystem locations, not names inferred from target data. */
  readonly logicalPathFields?: LogicalPathFields;
  readonly analysisProfile?: AnalysisProfileCommitment;
  readonly rawResult?: unknown;
  readonly confidence?: "observed" | "derived" | "inferred";
  readonly authority?: EvidenceAuthority;
  readonly environment?: ExecutionEnvironment | null;
  readonly limitations?: readonly string[];
  readonly relationshipCoverage?: RelationshipCoverage;
  /** Reason the subject identity is unavailable, when no target identity is supplied. */
  readonly subjectUnavailableReason?: string;
  readonly locations?: readonly EvidenceLocation[];
  readonly evidenceLinks?: readonly string[];
}

/** Producer facts that already promise JSON, including cooperative Evidence input. */
export interface EvidenceObservation extends EvidenceObservationInput {
  readonly parameters: Readonly<Record<string, JsonValue>>;
  readonly result: JsonValue;
  readonly rawResult?: JsonValue;
}

type EvidenceWithoutId = Omit<EvidenceSchemaValue, "evidence_id">;

/** Target identity shared by semantic commitments, excluding caller-selected display paths. */
export const evidenceSubjectIdentity = (subject: Evidence["subject"]) =>
  subject === null
    ? null
    : {
        digest: subject.digest,
        format: subject.format,
        architecture: subject.architecture,
      };

/** Content committed by an Evidence ID, excluding local request/display metadata. */
export const evidenceSemanticContent = (
  evidence: EvidenceWithoutId,
): Record<string, JsonValue> => ({
  subject: evidenceSubjectIdentity(evidence.subject),
  provider: evidence.provider,
  analysis_profile: evidence.analysis_profile,
  predicate_type: evidence.predicate_type,
  operation: evidence.operation,
  parameters: evidence.parameters,
  raw_result: evidence.raw_result,
  normalized_result: evidence.normalized_result,
  confidence: evidence.confidence,
  authority: evidence.authority,
  environment: evidence.environment,
  limitations: evidence.limitations,
  relationship_coverage: evidence.relationship_coverage,
  locations: evidence.locations,
  evidence_links: evidence.evidence_links,
});

/** Hash semantic content, including raw results and excluding local metadata. */
const computeEvidenceId = (evidence: EvidenceWithoutId): string =>
  `ev_${digestCanonicalValue(evidenceSemanticContent(evidence), "Evidence")}`;

/** Recognize an obsolete commitment for diagnosis only; never admit or rewrite it. */
const usesPre66NullCoverageIdentity = (
  evidence: EvidenceWithoutId,
  evidenceId: string,
): boolean => {
  if (evidence.relationship_coverage !== null) return false;
  const legacyProjection = evidenceSemanticContent(evidence);
  delete legacyProjection.relationship_coverage;
  return (
    evidenceId ===
    `ev_${digestCanonicalValue(legacyProjection, "Historical Evidence identity")}`
  );
};

/** Parse evidence and reject a syntactically valid but tampered semantic ID. */
export const parseEvidence = (input: unknown): Evidence => {
  const immutable =
    typeof input === "object" && input !== null
      ? immutableEvidenceSnapshots.get(input)
      : undefined;
  if (immutable !== undefined) return immutable;
  return authenticatedEvidenceSchema.parse(input);
};

/** Evidence owns all presentation metadata excluded from its semantic identity. */
export const evidenceDisplayMetadataAgree = (
  left: Evidence,
  right: Evidence,
): boolean =>
  left.subject?.name === right.subject?.name &&
  left.subject?.local_path === right.subject?.local_path &&
  left.caller_input_path === right.caller_input_path &&
  isDeepStrictEqual(left.caller_input_paths, right.caller_input_paths);

/** Recognize authenticated Evidence in a union of partial observations. */
export const tryParseEvidence = (input: unknown): Evidence | undefined => {
  if (typeof input !== "object" || input === null || !("evidence_id" in input))
    return undefined;
  const immutable = immutableEvidenceSnapshots.get(input);
  if (immutable !== undefined) return immutable;
  const parsed = authenticatedEvidenceSchema.safeParse(input);
  return parsed.success ? parsed.data : undefined;
};

/** Authenticate and seal a ledger-owned snapshot; external mutable values are copied first. */
export const immutableEvidence = (input: unknown): Evidence => {
  const parsed = parseEvidence(input);
  return rememberImmutableEvidence(
    canBorrowParsedJsonSnapshot(input, parsed) ? input : parsed,
  );
};

/** Rebind display path metadata when an authenticated record names this target. */
export const rebindEvidenceToTargetPath = (
  evidence: Evidence,
  target: EvidenceSubjectTarget,
): Evidence => {
  const subject = evidence.subject;
  if (subject === null) return evidence;
  const rebound = rebindEvidenceSubjectTargetPath(
    {
      path: subject.local_path,
      sha256: subject.digest.sha256,
      format: subject.format,
      ...(subject.architecture === null
        ? {}
        : { architecture: subject.architecture }),
    },
    target,
  );
  if (rebound.path === subject.local_path) return evidence;
  const reboundSubject = subjectSchema.parse({
    ...subject,
    name: basename(target.path) || "artifact",
    local_path: target.path,
  });
  const reboundEvidence = { ...evidence, subject: reboundSubject };
  if (!isImmutableEvidence(evidence)) return immutableEvidence(reboundEvidence);

  // The original authenticated Evidence owns immutable payloads. Only the
  // small display subject and envelope are new, so preserve those payloads
  // without reparsing a potentially large analysis result.
  return rememberReboundEvidence(evidence, reboundEvidence);
};

/** Bind the exact selected request path without changing semantic identity or stored history. */
export const withEvidenceCallerInputPath = (
  evidence: Evidence,
  rawPath: string,
  additionalPaths?: Readonly<Record<string, string>>,
): Evidence => {
  const callerInputPath = nulFreeStringSchema.parse(rawPath);
  const owned = immutableEvidence(evidence);
  const paths =
    additionalPaths === undefined
      ? undefined
      : callerInputPathsSchema.parse(additionalPaths);
  const samePaths =
    paths === undefined || isDeepStrictEqual(owned.caller_input_paths, paths);
  if (owned.caller_input_path === callerInputPath && samePaths) return owned;
  // The authenticated source owns its immutable payloads. Only this small
  // envelope changes, so replay does not copy a document-sized result.
  const rebound = {
    ...owned,
    caller_input_path: callerInputPath,
    ...(paths === undefined ? {} : { caller_input_paths: paths }),
  };
  return rememberReboundEvidence(owned, rebound);
};

/** Carry the source's sealing proof before sealing only the changed envelope. */
const rememberReboundEvidence = (
  source: Evidence,
  rebound: Evidence,
): Evidence => {
  // Each own member belongs to an authenticated immutable source. Register
  // these shared roots so sealing the envelope never walks their payloads.
  for (const key of Object.keys(source))
    immutableJsonSnapshotMember(source, key);
  return rememberImmutableEvidence(rebound);
};

/** Recognize authenticated Evidence whose complete reachable JSON data is immutable. */
export const isImmutableEvidence = (evidence: Evidence): boolean =>
  immutableEvidenceSnapshots.has(evidence);

const rememberImmutableEvidence = (evidence: Evidence): Evidence => {
  freezeJsonSnapshot(evidence);
  immutableEvidenceSnapshots.set(evidence, evidence);
  return evidence;
};

/** Ownership policy for the freshly parsed Evidence snapshot. */
export interface EvidenceCreationOptions {
  readonly immutable?: boolean;
  /** Opt-in configuration for logical path root redaction at Evidence creation time. */
  readonly logicalRoot?: LogicalPathRootMapping;
}

/** Admit payloads into deterministic Evidence bound to an immutable artifact subject. */
export const createEvidence = (
  target: EvidenceSubjectTarget | BinaryTarget | undefined,
  provider: EvidenceProvider,
  observation: EvidenceObservationInput,
  options?: EvidenceCreationOptions,
): Evidence => {
  const { normalized, sharedResult } = normalizeEvidenceObservation(
    target,
    provider,
    observation,
    options,
  );
  const evidence = {
    ...normalized,
    evidence_id: computeEvidenceId(normalized),
  };
  // Seal this already parsed, exclusively owned snapshot without authenticating
  // or copying its payload again, including later partial-error delivery.
  if (sharedResult || options?.immutable === true) {
    // The normalizer's JSON parser clones mutable payloads into trees and only
    // borrows previously sealed roots. No graph-sized sealing scratch is needed.
    freezeOwnedJsonTreeSnapshot(evidence);
    immutableEvidenceSnapshots.set(evidence, evidence);
  }
  return evidence;
};

/** Create Evidence from owned immutable JSON while exposing cooperative computation steps. */
export function* createImmutableEvidenceSteps(
  target: EvidenceSubjectTarget | BinaryTarget | undefined,
  provider: EvidenceProvider,
  observation: EvidenceObservation,
  options?: EvidenceCreationOptions,
): Generator<void, Evidence> {
  if (!isImmutableJsonSnapshot(observation.result))
    throw new TypeError(
      "Cooperative Evidence requires an authenticated immutable result",
    );
  // The envelope parser below retains its usual diagnostics, using the completed
  // immutable validation rather than traversing the payload synchronously again.
  yield* jsonValueValidationSteps(observation.result);
  const applied =
    options?.logicalRoot === undefined
      ? undefined
      : yield* applyLogicalRootRedactionSteps(
          target,
          observation,
          options.logicalRoot,
        );
  const { normalized } = normalizeEvidenceObservation(
    target,
    provider,
    observation,
    options,
    applied,
  );
  const digest = yield* canonicalJsonDigestSteps(
    evidenceSemanticContent(normalized),
  );
  return rememberImmutableEvidence({
    ...normalized,
    evidence_id: `ev_${digest}`,
  });
}

interface AppliedLogicalPathRootOutcome {
  readonly effectiveTarget: EvidenceSubjectTarget | BinaryTarget | undefined;
  readonly effectiveObservation: EvidenceObservationInput;
  readonly addedLimitations: readonly string[];
}

const applyLogicalRootRedaction = (
  target: EvidenceSubjectTarget | BinaryTarget | undefined,
  observation: EvidenceObservationInput,
  mapping: LogicalPathRootMapping,
): AppliedLogicalPathRootOutcome => {
  const steps = applyLogicalRootRedactionSteps(target, observation, mapping);
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
  }
};

function* applyLogicalRootRedactionSteps(
  target: EvidenceSubjectTarget | BinaryTarget | undefined,
  observation: EvidenceObservationInput,
  mapping: LogicalPathRootMapping,
): Generator<void, AppliedLogicalPathRootOutcome> {
  let outsideCount = 0;
  let effectiveTarget = target;
  if (target !== undefined) {
    const res = normalizeLogicalPath(target.path, mapping);
    if (res.kind === "mapped") {
      effectiveTarget = {
        ...target,
        path: res.path,
      };
    } else if (res.kind === "outside-root") {
      outsideCount += 1;
    } else if (res.kind === "invalid") {
      throw new Error(res.reason);
    }
  }

  const {
    observation: effectiveObservation,
    mappedCount,
    outsideCount: obsOutsideCount,
  } = yield* redactEvidenceObservationPathsSteps(observation, mapping);

  const totalOutsideCount = outsideCount + obsOutsideCount;
  const addedLimitations: string[] = [];
  addedLimitations.push(
    observation.logicalPathFields === undefined
      ? "logical-root redaction incomplete; producer did not declare filesystem field locations."
      : "logical-root mapping covers only producer-declared filesystem fields; other recorded data may contain host paths.",
  );
  const prefix = normalizeLogicalPrefix(
    mapping.logicalPrefix ?? DEFAULT_LOGICAL_ROOT_PREFIX,
  );
  if (
    mappedCount > 0 ||
    (target !== undefined && effectiveTarget?.path !== target.path)
  ) {
    addedLimitations.push(
      `Local filesystem paths under configured logical root were normalized to '${prefix}' before Evidence sealing.`,
    );
  }
  if (totalOutsideCount > 0) {
    addedLimitations.push(
      "logical-root redaction incomplete; host-local path retained.",
    );
  }

  return { effectiveTarget, effectiveObservation, addedLimitations };
}

const normalizeEvidenceObservation = (
  target: EvidenceSubjectTarget | BinaryTarget | undefined,
  provider: EvidenceProvider,
  observation: EvidenceObservationInput,
  options?: EvidenceCreationOptions,
  applied?: AppliedLogicalPathRootOutcome,
) => {
  const { effectiveTarget, effectiveObservation, addedLimitations } =
    applied ??
    (options?.logicalRoot !== undefined
      ? applyLogicalRootRedaction(target, observation, options.logicalRoot)
      : {
          effectiveTarget: target,
          effectiveObservation: observation,
          addedLimitations: [],
        });

  const subject =
    effectiveTarget === undefined
      ? null
      : {
          name: basename(effectiveTarget.path) || "artifact",
          digest: { sha256: effectiveTarget.sha256 },
          format: effectiveTarget.format,
          architecture: effectiveTarget.architecture ?? null,
          local_path: effectiveTarget.path,
        };
  const semantic = {
    subject:
      subject === null
        ? null
        : {
            digest: subject.digest,
            format: subject.format,
            architecture: subject.architecture,
          },
    provider: {
      id: provider.id,
      name: provider.name,
      version: provider.version,
    },
    analysis_profile: effectiveObservation.analysisProfile ?? null,
    predicate_type:
      effectiveObservation.predicateType ?? ANALYSIS_EVIDENCE_PREDICATE,
    operation: effectiveObservation.operation,
    parameters: effectiveObservation.parameters,
    raw_result: effectiveObservation.rawResult ?? null,
    normalized_result: effectiveObservation.result,
    confidence: effectiveObservation.confidence ?? "observed",
    authority: effectiveObservation.authority ?? "shipped-artifact",
    environment: effectiveObservation.environment ?? null,
    limitations: [
      ...(effectiveTarget === undefined
        ? [
            effectiveObservation.subjectUnavailableReason ??
              "Artifact identity is unavailable for this observation.",
          ]
        : []),
      ...(effectiveObservation.limitations ?? []),
      ...addedLimitations,
    ],
    ...(effectiveObservation.relationshipCoverage === undefined
      ? { relationship_coverage: null }
      : { relationship_coverage: effectiveObservation.relationshipCoverage }),
    locations: [...(effectiveObservation.locations ?? [])],
    evidence_links: [...(effectiveObservation.evidenceLinks ?? [])],
  };
  const sharedResult =
    typeof effectiveObservation.result === "object" &&
    effectiveObservation.result !== null &&
    isImmutableJsonSnapshot(effectiveObservation.result);
  const selectedSchema = sharedResult
    ? evidenceSchema.safeExtend({ normalized_result: immutableResultSchema })
    : evidenceSchema;
  const normalized = selectedSchema.parse({
    ...semantic,
    evidence_id: `ev_${"0".repeat(64)}`,
    subject,
  });
  // The envelope has already been parsed into an independent snapshot. Only
  // its derived identifier changes here; parsing again clones the full payload
  // and recomputes the same digest while the previous snapshot is still live.
  return { normalized, sharedResult };
};
