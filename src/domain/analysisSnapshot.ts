import { createHash } from "node:crypto";

import canonicalize from "canonicalize";
import { z } from "zod";

import type {
  AnalysisExecution,
  AnalysisOperation,
} from "../application/AnalysisProvider.js";
import type { BinaryTarget } from "./binaryTarget.js";
import {
  evidenceBundleForTarget,
  evidenceBundleSchema,
  parseEvidenceBundle,
} from "./evidenceBundle.js";
import {
  evidenceLocationSchema,
  providerSchema,
  type Evidence,
} from "./evidence.js";
import {
  jsonObjectSchema,
  jsonValueSchema,
  type JsonValue,
} from "./jsonValue.js";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const architectureSchema = z.enum(["x86", "x86_64", "arm", "arm64"]);
const formatSchema = z.enum([
  "hopper",
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
const subjectSchema = z.object({
  path: z.string().min(1),
  sha256: digestSchema,
  format: z.enum([
    ...formatSchema.options,
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
  format: formatSchema,
  architecture: architectureSchema.nullable(),
  loader_args: z.array(z.string()),
});
const entrySchema = z.object({
  query_id: z.string().regex(/^query_[a-f0-9]{64}$/u),
  operation: z.string().min(1),
  parameters: jsonObjectSchema,
  execution: z.object({
    result: jsonValueSchema,
    raw_result: jsonValueSchema.nullable(),
    provider: providerSchema,
    limitations: z.array(z.string()),
    locations: z.array(evidenceLocationSchema),
    subject: subjectSchema.nullable(),
  }),
});

/** Provider-neutral, deterministic cache of successful immutable analysis calls. */
export const analysisSnapshotSchema = z.object({
  snapshot_version: z.literal(1),
  target: targetSchema,
  entries: z.array(entrySchema).max(10_000),
  evidence_bundle: evidenceBundleSchema,
});

export type AnalysisSnapshot = z.infer<typeof analysisSnapshotSchema>;
export type AnalysisSnapshotEntry = z.infer<typeof entrySchema>;
export type AnalysisSnapshotTarget = z.infer<typeof targetSchema>;

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
  format: target.format,
  architecture: target.architecture ?? null,
  loader_args: [...target.loaderArgs],
});

/** Compare an open binary with the immutable identity in a snapshot. */
export const snapshotMatchesTarget = (
  snapshot: AnalysisSnapshotTarget,
  target: BinaryTarget,
): boolean =>
  snapshot.sha256 === target.sha256 &&
  snapshot.format === target.format &&
  snapshot.architecture === (target.architecture ?? null) &&
  JSON.stringify(snapshot.loader_args) === JSON.stringify(target.loaderArgs);

/** Find exact persisted CLI evidence without starting an analysis provider. */
export const snapshotEvidenceForQuery = (
  snapshot: AnalysisSnapshot,
  query: {
    readonly target: BinaryTarget;
    readonly operation: string;
    readonly parameters: Readonly<Record<string, JsonValue>>;
    readonly provider: AnalysisExecution["provider"];
  },
): Evidence | undefined => {
  const { target, operation, parameters, provider } = query;
  if (!snapshotMatchesTarget(snapshot.target, target)) return undefined;
  const encodedParameters = canonicalJson(parameters);
  return snapshot.evidence_bundle.records.find(
    (record) =>
      record.subject?.digest.sha256 === target.sha256 &&
      record.operation === operation &&
      record.provider.id === provider.id &&
      record.provider.name === provider.name &&
      record.provider.version === provider.version &&
      canonicalJson(record.parameters) === encodedParameters,
  );
};

/** Compute the stable lookup key for one provider-specific analysis query. */
export const analysisQueryId = (
  target: AnalysisSnapshotTarget,
  operation: string,
  parameters: Readonly<Record<string, JsonValue>>,
  provider: AnalysisExecution["provider"],
): string =>
  `query_${createHash("sha256")
    .update(
      canonicalJson({
        target,
        operation,
        parameters,
        provider: {
          id: provider.id,
          name: provider.name,
          version: provider.version,
        },
      }),
    )
    .digest("hex")}`;

/** Create one serializable snapshot entry from a successful provider call. */
export const createAnalysisSnapshotEntry = (
  target: AnalysisSnapshotTarget,
  operation: AnalysisOperation,
  parameters: Readonly<Record<string, JsonValue>>,
  execution: AnalysisExecution,
): AnalysisSnapshotEntry => ({
  query_id: analysisQueryId(target, operation, parameters, execution.provider),
  operation,
  parameters: jsonObjectSchema.parse(parameters),
  execution: {
    result: execution.result,
    raw_result: execution.rawResult,
    provider: execution.provider,
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
});

/** Parse a snapshot and reject altered query IDs or non-canonical entry order. */
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
  for (const entry of parsed.entries) {
    const expected = analysisQueryId(
      parsed.target,
      entry.operation,
      entry.parameters,
      entry.execution.provider,
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
