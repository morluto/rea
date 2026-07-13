import { createHash } from "node:crypto";

import canonicalize from "canonicalize";
import { z } from "zod";

import type { BinaryTarget } from "./binaryTarget.js";
import { jsonValueSchema, type JsonValue } from "./jsonValue.js";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
/** Provider identity schema shared by evidence-bearing persistence formats. */
export const providerSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().nullable(),
});
const subjectSchema = z.object({
  name: z.string().min(1),
  digest: z.object({ sha256: digestSchema }),
  format: z.enum([
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
    "directory",
    "file",
    "unknown",
    "mach-o-universal",
    "javascript-bundle",
    "entitlements",
  ]),
  architecture: z.enum(["x86", "x86_64", "arm", "arm64"]).nullable(),
  local_path: z.string(),
});
/** Source location attached to an evidence observation. */
/** Source-location schema shared by evidence-bearing persistence formats. */
export const evidenceLocationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("address"), address: z.string().min(1) }),
  z.object({
    kind: z.literal("address-range"),
    start: z.string().min(1),
    end: z.string().min(1),
  }),
  z.object({ kind: z.literal("artifact-path"), path: z.string().min(1) }),
  z.object({ kind: z.literal("file-offset"), offset: z.number().int().min(0) }),
  z.object({
    kind: z.literal("file-offset-range"),
    start: z.number().int().min(0),
    end: z.number().int().min(0),
  }),
]);

const evidenceAuthoritySchema = z.enum([
  "shipped-artifact",
  "controlled-replay",
  "historical-reference",
  "external-service",
  "analyst-inference",
]);

const executionEnvironmentSchema = z.object({
  id: z.string().min(1),
  platform: z.string().min(1),
  architecture: z.string().min(1),
  isolation: z.enum(["none", "process", "container", "virtual-machine"]),
});

/** Strict, provider-neutral record for one successful public observation. */
export const evidenceSchema = z.object({
  schema_version: z.literal(2),
  evidence_id: z.string().regex(/^ev_[a-f0-9]{64}$/u),
  subject: subjectSchema.nullable(),
  provider: providerSchema,
  predicate_type: z.string().min(1),
  operation: z.string().min(1),
  parameters: z.record(z.string(), jsonValueSchema),
  raw_result: jsonValueSchema.nullable(),
  normalized_result: jsonValueSchema,
  confidence: z.enum(["observed", "derived", "inferred"]),
  authority: evidenceAuthoritySchema,
  environment: executionEnvironmentSchema.nullable(),
  limitations: z.array(z.string()),
  locations: z.array(evidenceLocationSchema),
  evidence_links: z.array(z.string().regex(/^ev_[a-f0-9]{64}$/u)),
});

export type Evidence = z.infer<typeof evidenceSchema>;
export type EvidenceLocation = z.infer<typeof evidenceLocationSchema>;

/** Minimal immutable local artifact identity accepted by Evidence v2. */
export interface EvidenceSubjectTarget {
  readonly path: string;
  readonly sha256: string;
  readonly format: z.infer<typeof subjectSchema>["format"];
  readonly architecture?: "x86" | "x86_64" | "arm" | "arm64";
}
type EvidenceAuthority = z.infer<typeof evidenceAuthoritySchema>;
type ExecutionEnvironment = z.infer<typeof executionEnvironmentSchema>;

export interface EvidenceProvider {
  readonly id: string;
  readonly name: string;
  readonly version: string | null;
}

export interface EvidenceObservation {
  readonly predicateType?: string;
  readonly operation: string;
  readonly parameters: Readonly<Record<string, JsonValue>>;
  readonly result: JsonValue;
  readonly rawResult?: JsonValue;
  readonly confidence?: "observed" | "derived" | "inferred";
  readonly authority?: EvidenceAuthority;
  readonly environment?: ExecutionEnvironment | null;
  readonly limitations?: readonly string[];
  readonly locations?: readonly EvidenceLocation[];
  readonly evidenceLinks?: readonly string[];
}

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

/** Serialize JSON according to RFC 8785 JSON Canonicalization Scheme. */
const canonicalJson = (value: JsonValue): string => {
  const serialized = canonicalize(value);
  if (serialized === undefined)
    throw new TypeError("RFC 8785 canonicalization rejected a JSON value");
  return serialized;
};

const semanticProjection = (
  evidence: Omit<Evidence, "evidence_id">,
): JsonValue => ({
  schema_version: evidence.schema_version,
  subject:
    evidence.subject === null
      ? null
      : {
          digest: evidence.subject.digest,
          format: evidence.subject.format,
          architecture: evidence.subject.architecture,
        },
  provider: evidence.provider,
  predicate_type: evidence.predicate_type,
  operation: evidence.operation,
  parameters: evidence.parameters,
  raw_result: evidence.raw_result,
  normalized_result: evidence.normalized_result,
  confidence: evidence.confidence,
  authority: evidence.authority,
  environment: evidence.environment,
  limitations: evidence.limitations,
  locations: evidence.locations,
  evidence_links: evidence.evidence_links,
});

/** Recompute the semantic identifier, excluding paths and raw payload bytes. */
const computeEvidenceId = (evidence: Omit<Evidence, "evidence_id">): string =>
  `ev_${sha256(canonicalJson(semanticProjection(evidence)))}`;

/** Parse evidence and reject a syntactically valid but tampered semantic ID. */
export const parseEvidence = (input: unknown): Evidence => {
  if (
    typeof input === "object" &&
    input !== null &&
    "schema_version" in input &&
    input.schema_version !== 2
  )
    throw new TypeError(
      `Unsupported evidence schema_version ${String(input.schema_version)}; Evidence v1 is not accepted. Produce Evidence v2.`,
    );
  const evidence = evidenceSchema.parse(input);
  const { evidence_id: evidenceId, ...withoutId } = evidence;
  if (computeEvidenceId(withoutId) !== evidenceId)
    throw new TypeError(
      "Evidence semantic identifier does not match its record",
    );
  return evidence;
};

/** Build deterministic Evidence v2 from an immutable artifact subject. */
export const createEvidence = (
  target: EvidenceSubjectTarget | BinaryTarget | undefined,
  provider: EvidenceProvider,
  observation: EvidenceObservation,
): Evidence => {
  const subject =
    target === undefined
      ? null
      : {
          name: target.path.split("/").at(-1) ?? target.path,
          digest: { sha256: target.sha256 },
          format: target.format,
          architecture: target.architecture ?? null,
          local_path: target.path,
        };
  const semantic = {
    schema_version: 2,
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
    predicate_type: observation.predicateType ?? "rea.analysis/v2",
    operation: observation.operation,
    parameters: observation.parameters,
    raw_result: observation.rawResult ?? null,
    normalized_result: observation.result,
    confidence: observation.confidence ?? "observed",
    authority: observation.authority ?? "shipped-artifact",
    environment: observation.environment ?? null,
    limitations: [
      ...(target === undefined
        ? ["Artifact identity is unavailable for this observation."]
        : []),
      ...(observation.limitations ?? []),
    ],
    locations: [...(observation.locations ?? [])],
    evidence_links: [...(observation.evidenceLinks ?? [])],
  } satisfies JsonValue;
  return evidenceSchema.parse({
    ...semantic,
    evidence_id: `ev_${sha256(canonicalJson(semantic))}`,
    subject,
  });
};
