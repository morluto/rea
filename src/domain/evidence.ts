import { createHash } from "node:crypto";

import canonicalize from "canonicalize";
import { z } from "zod";

import type { BinaryTarget } from "./binaryTarget.js";
import { jsonValueSchema, type JsonValue } from "./jsonValue.js";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const providerSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().nullable(),
});
const subjectSchema = z.object({
  name: z.string().min(1),
  digest: z.object({ sha256: digestSchema }),
  format: z.enum(["hopper", "mach-o", "elf", "pe"]),
  architecture: z.enum(["x86", "x86_64", "arm", "arm64"]).nullable(),
  local_path: z.string(),
});
const locationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("address"), address: z.string().min(1) }),
  z.object({
    kind: z.literal("address-range"),
    start: z.string().min(1),
    end: z.string().min(1),
  }),
  z.object({ kind: z.literal("artifact-path"), path: z.string().min(1) }),
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
  result: jsonValueSchema,
  raw_payload_sha256: digestSchema.nullable(),
  confidence: z.enum(["observed", "derived", "inferred"]),
  authority: evidenceAuthoritySchema,
  environment: executionEnvironmentSchema.nullable(),
  limitations: z.array(z.string()),
  locations: z.array(locationSchema),
  evidence_links: z.array(z.string().regex(/^ev_[a-f0-9]{64}$/u)),
});

export type Evidence = z.infer<typeof evidenceSchema>;
type EvidenceLocation = z.infer<typeof locationSchema>;
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
  readonly redactedRawPayload?: JsonValue;
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
  result: evidence.result,
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
  target: BinaryTarget | undefined,
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
    result: observation.result,
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
    raw_payload_sha256:
      observation.redactedRawPayload === undefined
        ? null
        : sha256(canonicalJson(observation.redactedRawPayload)),
  });
};
