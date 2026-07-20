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

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const architectureSchema = z.enum(["x86", "x86_64", "arm", "arm64"]);
const formatSchema = z.enum([
  "analysis-database",
  "mach-o",
  "elf",
  "pe",
  "zip",
  "ipa",
  "apk",
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
    "dex",
    "jvm-class",
    "webassembly",
    "android-manifest",
    "android-resources",
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
  query_id: z.string().regex(/^query_[a-f0-9]{64}$/u),
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
  snapshot_version: z.literal(2),
  target: targetSchema,
  binding: bindingSchema,
  entries: z.array(entrySchema).max(10_000),
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

/** Build the immutable provider/profile binding used by snapshot v2. */
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

/** Parse v2 and reject legacy snapshots, altered query IDs, or non-canonical order. */
export const parseAnalysisSnapshot = (input: unknown): AnalysisSnapshot => {
  rejectLegacySnapshot(input);
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
  }
  const sorted = [...parsed.entries].sort((left, right) =>
    left.query_id.localeCompare(right.query_id),
  );
  if (JSON.stringify(parsed.entries) !== JSON.stringify(sorted))
    throw new TypeError("Analysis snapshot entries are not canonical");
  return parsed;
};

/** Serialize a validated snapshot with byte-stable canonical entry ordering. */
export const serializeAnalysisSnapshot = (snapshot: AnalysisSnapshot): string =>
  `${canonicalJson(parseAnalysisSnapshot(snapshot))}\n`;

const rejectLegacySnapshot = (input: unknown): void => {
  if (
    typeof input === "object" &&
    input !== null &&
    "snapshot_version" in input &&
    input.snapshot_version === 1
  )
    throw new TypeError(
      "Analysis snapshot v1 is incompatible with profile-exact replay; recapture it as snapshot v2. Its Evidence bundle may be imported separately.",
    );
};
