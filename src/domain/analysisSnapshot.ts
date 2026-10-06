import { createHash } from "node:crypto";

import canonicalize from "canonicalize";
import { z } from "zod";

import {
  analysisProfileSchema,
  analysisProfilesEqual,
  committedProviderSchema,
  type AnalysisProfileCommitment,
} from "./analysisProfile.js";
import type { BinaryTarget } from "./binaryTarget.js";
import {
  evidenceBundleForTarget,
  evidenceBundleSchema,
  parseEvidenceBundle,
} from "./evidenceBundle.js";
import {
  evidenceLocationSchema,
  type Evidence,
  type EvidenceLocation,
  type EvidenceSubjectTarget,
} from "./evidence.js";
import {
  jsonObjectSchema,
  jsonValueSchema,
  type JsonValue,
} from "./jsonValue.js";
import { digestSchema } from "./../domain/digests.js";
import { prefixedDigestSchema } from "./../domain/digests.js";

const architectureSchema = z.enum(["x86", "x86_64", "arm", "arm64"]);
const formatSchema = z.enum([
  "analysis-database",
  "mach-o",
  "elf",
  "pe",
  "dos-mz",
  "dos-com",
  "zip",
  "ipa",
  "apk",
  "msix",
  "appx",
  "asar",
  "dmg",
  "pkg",
  "plist",
  "javascript",
  "source-map",
]);
const kindSchema = z.enum(["executable", "database", "archive", "artifact"]);
const subjectSchema = z.object({
  path: z.string().min(1),
  sha256: digestSchema,
  format: z.enum([
    ...formatSchema.options,
    "hopper",
    "directory",
    "file",
    "unknown",
    "mach-o-universal",
    "javascript-bundle",
    "entitlements",
  ]),
  architecture: architectureSchema.nullable(),
});
const targetSchema = z.object({
  sha256: digestSchema,
  kind: kindSchema,
  format: formatSchema,
  architecture: architectureSchema.nullable(),
});
const bindingSchema = z
  .object({
    provider: committedProviderSchema,
    analysis_profile: analysisProfileSchema,
  })
  .superRefine((binding, context) => {
    if (
      binding.provider.id !== binding.analysis_profile.provider.id ||
      binding.provider.name !== binding.analysis_profile.provider.name ||
      binding.provider.version !== binding.analysis_profile.provider.version
    )
      context.addIssue({
        code: "custom",
        path: ["provider"],
        message: "Snapshot binding provider does not match analysis profile",
      });
  });
const entrySchema = z.object({
  query_id: prefixedDigestSchema("query"),
  operation: z.string().min(1),
  parameters: jsonObjectSchema,
  execution: z.object({
    result: jsonValueSchema,
    raw_result: jsonValueSchema.nullable(),
    provider: committedProviderSchema,
    limitations: z.array(z.string()),
    locations: z.array(evidenceLocationSchema),
    subject: subjectSchema.nullable(),
  }),
});

/** Provider- and profile-exact cache of successful immutable analysis calls. */
export const analysisSnapshotSchema = z.object({
  target: targetSchema,
  binding: bindingSchema,
  entries: z.array(entrySchema),
  evidence_bundle: evidenceBundleSchema,
});

export type AnalysisSnapshot = z.infer<typeof analysisSnapshotSchema>;
export type AnalysisSnapshotEntry = z.infer<typeof entrySchema>;
export type AnalysisSnapshotTarget = z.infer<typeof targetSchema>;
export type AnalysisSnapshotBinding = z.infer<typeof bindingSchema>;

interface SnapshotExecution {
  readonly result: JsonValue;
  readonly rawResult: JsonValue | null;
  readonly provider: {
    readonly id: string;
    readonly name: string;
    readonly version: string | null;
  };
  readonly analysisProfile?: AnalysisProfileCommitment;
  readonly limitations: readonly string[];
  readonly locations: readonly EvidenceLocation[];
  readonly subject: EvidenceSubjectTarget | null;
}

const canonicalJson = (value: unknown): string => {
  const json = jsonValueSchema.parse(value);
  const encoded = canonicalize(json);
  if (encoded === undefined)
    throw new TypeError("RFC 8785 canonicalization rejected snapshot data");
  return encoded;
};

/** Project a binary into the path-free identity used for cache invalidation. */
export const snapshotTarget = (
  target: BinaryTarget,
): AnalysisSnapshotTarget => ({
  sha256: target.sha256,
  kind: target.kind,
  format: target.format,
  architecture: target.architecture ?? null,
});

/** Build the immutable provider/profile binding used by a cached snapshot. */
export const snapshotBinding = (
  profile: AnalysisProfileCommitment,
): AnalysisSnapshotBinding =>
  bindingSchema.parse({
    provider: profile.provider,
    analysis_profile: profile,
  });

/** Compare an open binary with the immutable target identity in a snapshot. */
export const snapshotMatchesTarget = (
  snapshot: AnalysisSnapshotTarget,
  target: BinaryTarget,
): boolean =>
  snapshot.sha256 === target.sha256 &&
  snapshot.kind === target.kind &&
  snapshot.format === target.format &&
  snapshot.architecture === (target.architecture ?? null);

/** Compare a snapshot binding with the selected concrete analysis profile. */
export const snapshotMatchesProfile = (
  binding: AnalysisSnapshotBinding,
  profile: AnalysisProfileCommitment,
): boolean =>
  binding.provider.id === profile.provider.id &&
  binding.provider.name === profile.provider.name &&
  binding.provider.version === profile.provider.version &&
  analysisProfilesEqual(binding.analysis_profile, profile);

/** Require an exact target and selected provider/profile cache partition. */
export const snapshotMatchesBinding = (
  snapshot: Pick<AnalysisSnapshot, "target" | "binding">,
  target: BinaryTarget,
  profile: AnalysisProfileCommitment,
): boolean =>
  snapshotMatchesTarget(snapshot.target, target) &&
  snapshotMatchesProfile(snapshot.binding, profile);

/** Find exact persisted CLI Evidence without starting an analysis provider. */
export const snapshotEvidenceForQuery = (
  snapshot: AnalysisSnapshot,
  query: {
    readonly target: BinaryTarget;
    readonly bindingProfile: AnalysisProfileCommitment;
    readonly operation: string;
    readonly parameters: Readonly<Record<string, JsonValue>>;
    readonly provider: SnapshotExecution["provider"];
    readonly evidenceProfile: AnalysisProfileCommitment;
  },
): Evidence | undefined => {
  const {
    target,
    bindingProfile,
    operation,
    parameters,
    provider,
    evidenceProfile,
  } = query;
  if (!snapshotMatchesBinding(snapshot, target, bindingProfile))
    return undefined;
  const encodedParameters = canonicalJson(parameters);
  return snapshot.evidence_bundle.records.find(
    (record) =>
      record.subject?.digest.sha256 === target.sha256 &&
      record.operation === operation &&
      record.provider.id === provider.id &&
      record.provider.name === provider.name &&
      record.provider.version === provider.version &&
      "analysis_profile" in record &&
      analysisProfilesEqual(record.analysis_profile, evidenceProfile) &&
      canonicalJson(record.parameters) === encodedParameters,
  );
};

/** Compute the stable lookup key for one provider/profile-specific query. */
export const analysisQueryId = (
  target: AnalysisSnapshotTarget,
  binding: AnalysisSnapshotBinding,
  operation: string,
  parameters: Readonly<Record<string, JsonValue>>,
): string =>
  `query_${createHash("sha256")
    .update(canonicalJson({ target, binding, operation, parameters }))
    .digest("hex")}`;

/** Create one serializable snapshot entry from a successful provider call. */
export const createAnalysisSnapshotEntry = (input: {
  readonly target: AnalysisSnapshotTarget;
  readonly binding: AnalysisSnapshotBinding;
  readonly operation: string;
  readonly parameters: Readonly<Record<string, JsonValue>>;
  readonly execution: SnapshotExecution;
}): AnalysisSnapshotEntry => {
  const { target, binding, operation, parameters, execution } = input;
  if (
    execution.analysisProfile === undefined ||
    !snapshotMatchesProfile(binding, execution.analysisProfile) ||
    execution.provider.id !== binding.provider.id ||
    execution.provider.name !== binding.provider.name ||
    execution.provider.version !== binding.provider.version
  )
    throw new TypeError(
      "Snapshot execution does not match its provider/profile binding",
    );
  return {
    query_id: analysisQueryId(target, binding, operation, parameters),
    operation,
    parameters: jsonObjectSchema.parse(parameters),
    execution: {
      result: execution.result,
      raw_result: execution.rawResult,
      provider: binding.provider,
      limitations: [...execution.limitations],
      locations: [...execution.locations],
      subject:
        execution.subject === null
          ? null
          : {
              ...execution.subject,
              architecture: execution.subject.architecture ?? null,
            },
    },
  };
};

/** Parse a provider/profile-exact snapshot and verify its entries and evidence. */
export const parseAnalysisSnapshot = (input: unknown): AnalysisSnapshot => {
  const parsed = analysisSnapshotSchema.parse(input);
  parseEvidenceBundle(parsed.evidence_bundle);
  if (
    JSON.stringify(
      evidenceBundleForTarget(parsed.evidence_bundle, parsed.target.sha256),
    ) !== JSON.stringify(parsed.evidence_bundle)
  )
    throw new TypeError(
      "Analysis snapshot evidence contains records for another target",
    );
  const ids = new Set<string>();
  const boundEntries: AnalysisSnapshotEntry[] = [];
  const index = createEvidenceIndex(parsed);
  for (const entry of parsed.entries) {
    if (
      entry.execution.provider.id !== parsed.binding.provider.id ||
      entry.execution.provider.name !== parsed.binding.provider.name ||
      entry.execution.provider.version !== parsed.binding.provider.version
    )
      throw new TypeError("Analysis snapshot entry provider does not match");
    const expected = analysisQueryId(
      parsed.target,
      parsed.binding,
      entry.operation,
      entry.parameters,
    );
    if (entry.query_id !== expected)
      throw new TypeError("Analysis snapshot query identifier does not match");
    if (ids.has(entry.query_id))
      throw new TypeError("Analysis snapshot contains duplicate queries");
    ids.add(entry.query_id);
    if (!entryHasMatchingEvidence(entry, parsed, index)) {
      if (entryHasCorrespondingEvidence(entry, parsed, index))
        throw new TypeError(
          `Analysis snapshot entry ${entry.operation} differs from its Evidence record`,
        );
      // Older snapshots may contain cache entries without profile-bound Evidence.
      // Keep their Evidence bundle, but never replay those unbound values.
      continue;
    }
    boundEntries.push(entry);
  }
  const sorted = [...parsed.entries].sort((left, right) =>
    left.query_id.localeCompare(right.query_id),
  );
  if (JSON.stringify(parsed.entries) !== JSON.stringify(sorted))
    throw new TypeError("Analysis snapshot entries are not canonical");
  return { ...parsed, entries: boundEntries };
};

/** Check that a cached provider execution is represented by bundled Evidence. */
interface EvidenceIndex {
  readonly matching: ReadonlySet<string>;
  readonly corresponding: ReadonlySet<string>;
}

const createEvidenceIndex = (
  snapshot: Pick<AnalysisSnapshot, "target" | "binding" | "evidence_bundle">,
): EvidenceIndex => {
  const matching = new Set<string>();
  const corresponding = new Set<string>();
  for (const evidence of snapshot.evidence_bundle.records) {
    if (!isCorrespondingEvidence(evidence, snapshot)) continue;
    const query = evidenceQueryKey(evidence);
    corresponding.add(query);
    matching.add(
      canonicalJson({
        query,
        normalized_result: evidence.normalized_result,
        raw_result: evidence.raw_result,
        limitations: evidence.limitations,
        locations: evidence.locations,
        subject:
          evidence.subject === null
            ? null
            : {
                local_path: evidence.subject.local_path,
                sha256: evidence.subject.digest.sha256,
                format: evidence.subject.format,
                architecture: evidence.subject.architecture,
              },
      }),
    );
  }
  const result = { matching, corresponding };
  return result;
};

const entryHasMatchingEvidence = (
  entry: AnalysisSnapshotEntry,
  snapshot: Pick<AnalysisSnapshot, "target" | "binding" | "evidence_bundle">,
  index: EvidenceIndex,
): boolean => index.matching.has(entryEvidenceKey(entry, snapshot.binding));

const entryHasCorrespondingEvidence = (
  entry: AnalysisSnapshotEntry,
  snapshot: Pick<AnalysisSnapshot, "target" | "binding" | "evidence_bundle">,
  index: EvidenceIndex,
): boolean => index.corresponding.has(entryQueryKey(entry, snapshot.binding));

const isCorrespondingEvidence = (
  evidence: Evidence,
  snapshot: Pick<AnalysisSnapshot, "target" | "binding">,
): boolean =>
  evidence.predicate_type === "rea.analysis" &&
  evidence.confidence === "observed" &&
  evidence.authority === "shipped-artifact" &&
  evidence.subject?.digest.sha256 === snapshot.target.sha256 &&
  "analysis_profile" in evidence &&
  analysisProfilesEqual(
    evidence.analysis_profile,
    snapshot.binding.analysis_profile,
  );

const evidenceQueryKey = (evidence: Evidence): string =>
  canonicalJson({
    operation: evidence.operation,
    parameters: evidence.parameters,
    provider: evidence.provider,
    analysis_profile:
      "analysis_profile" in evidence ? evidence.analysis_profile : null,
  });

const entryQueryKey = (
  entry: AnalysisSnapshotEntry,
  binding: AnalysisSnapshotBinding,
): string =>
  canonicalJson({
    operation: entry.operation,
    parameters: entry.parameters,
    provider: entry.execution.provider,
    analysis_profile: binding.analysis_profile,
  });

const entryEvidenceKey = (
  entry: AnalysisSnapshotEntry,
  binding: AnalysisSnapshotBinding,
): string =>
  canonicalJson({
    query: entryQueryKey(entry, binding),
    normalized_result: entry.execution.result,
    raw_result: entry.execution.raw_result,
    limitations: entry.execution.limitations,
    locations: entry.execution.locations,
    subject:
      entry.execution.subject === null
        ? null
        : {
            local_path: entry.execution.subject.path,
            sha256: entry.execution.subject.sha256,
            format: entry.execution.subject.format,
            architecture: entry.execution.subject.architecture,
          },
  });

/** Serialize a validated snapshot with byte-stable canonical entry ordering. */
export const serializeAnalysisSnapshot = (snapshot: AnalysisSnapshot): string =>
  `${canonicalJson(parseAnalysisSnapshot(snapshot))}\n`;
