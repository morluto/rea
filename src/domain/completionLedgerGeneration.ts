import { createHash } from "node:crypto";

import canonicalize from "canonicalize";
import { z } from "zod";

import {
  createEvidenceCompletionLedger,
  evidenceCompletionRecordSchema,
  type EvidenceCompletionLedger,
} from "./evidenceCompletionLedger.js";

const identifierSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,99}$/u);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const identitySchema = z.strictObject({
  id: identifierSchema,
  version: z.string().min(1).max(100),
});
const environmentSchema = z.strictObject({
  platform: identifierSchema,
  architecture: identifierSchema,
  runtime: identifierSchema,
  runtime_version: z.string().min(1).max(100),
});
const scenarioSchema = z.strictObject({
  id: identifierSchema,
  version: z.number().int().positive(),
});
const skillDigestSchema = z.strictObject({
  skill_id: identifierSchema,
  sha256: digestSchema,
});
const verifierRunSchema = z
  .strictObject({
    schema_version: z.literal(1),
    run_id: z.string().uuid(),
    verifier_pid: z.number().int().positive(),
    parent_pid: z.number().int().nonnegative(),
    process_lineage: z.discriminatedUnion("status", [
      z.strictObject({
        status: z.literal("verified"),
        schema_version: z.literal(1),
        observed_at: z.iso.datetime(),
        launcher_pid: z.number().int().positive(),
        launcher_parent_pid: z.number().int().nonnegative(),
        process_group_id: z.number().int().positive(),
        descendants: z.array(
          z.strictObject({
            pid: z.number().int().positive(),
            parent_pid: z.number().int().nonnegative(),
            process_group_id: z.number().int().positive(),
          }),
        ),
      }),
      z.strictObject({
        status: z.literal("unavailable"),
        observed_at: z.iso.datetime(),
        launcher_pid: z.number().int().positive(),
        launcher_parent_pid: z.number().int().nonnegative(),
        process_group_id: z.number().int().positive().nullable(),
        reason: z.string().min(1).max(500),
      }),
    ]),
  })
  .superRefine((run, context) => {
    if (run.process_lineage.launcher_pid !== run.verifier_pid)
      context.addIssue({
        code: "custom",
        path: ["process_lineage", "launcher_pid"],
        message: "Lineage launcher PID must identify the verifier process",
      });
    if (run.process_lineage.launcher_parent_pid !== run.parent_pid)
      context.addIssue({
        code: "custom",
        path: ["process_lineage", "launcher_parent_pid"],
        message: "Lineage parent PID must identify the verifier parent",
      });
  });
const reportClaimSchema = z.strictObject({
  claim_id: identifierSchema,
  scenario: scenarioSchema,
  artifact_sha256s: z.array(digestSchema).max(100),
  provider: identitySchema,
  result_schema_version: z.number().int().positive(),
  status: evidenceCompletionRecordSchema.shape.status,
  evidence_ids: evidenceCompletionRecordSchema.shape.evidence_ids,
});

const completionVerifierReportObjectSchema = z.strictObject({
  schema_version: z.literal(1),
  verifier: identitySchema,
  verifier_run: verifierRunSchema,
  environment: environmentSchema,
  claims: z.array(reportClaimSchema).min(1).max(10_000),
});

/** Strict output contract implemented by completion-aware verifiers. */
export const completionVerifierReportSchema =
  completionVerifierReportObjectSchema.superRefine((report, context) => {
    for (const [index, claim] of report.claims.entries())
      if (claim.status === "pass" && claim.artifact_sha256s.length === 0)
        context.addIssue({
          code: "custom",
          path: ["claims", index, "artifact_sha256s"],
          message: "Passing claims must commit at least one artifact digest",
        });
  });

export type CompletionVerifierReport = z.infer<
  typeof completionVerifierReportSchema
>;

const manifestClaimSchema = reportClaimSchema.omit({
  status: true,
  evidence_ids: true,
});
const completionManifestObjectSchema = z.strictObject({
  schema_version: z.literal(1),
  manifest_id: z.string().regex(/^ecm_[a-f0-9]{64}$/u),
  verifier: identitySchema,
  environment: environmentSchema,
  skill_digests: z.array(skillDigestSchema).min(1).max(100),
  claims: z.array(manifestClaimSchema).min(1).max(10_000),
});
type CompletionManifestValue = z.infer<typeof completionManifestObjectSchema>;

const compareIdentifiers = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const isSortedUnique = (values: readonly string[]): boolean =>
  values.every(
    (value, index) =>
      index === 0 || compareIdentifiers(values[index - 1] ?? "", value) < 0,
  );

const canonicalJson = (value: unknown): string => {
  const serialized = canonicalize(value);
  if (serialized === undefined)
    throw new TypeError(
      "RFC 8785 canonicalization rejected completion metadata",
    );
  return serialized;
};

const computeManifestId = (
  manifest: Omit<CompletionManifestValue, "manifest_id">,
): string =>
  `ecm_${createHash("sha256").update(canonicalJson(manifest)).digest("hex")}`;

const manifestIssues = (
  manifest: CompletionManifestValue,
  context: z.RefinementCtx,
): void => {
  if (!isSortedUnique(manifest.claims.map(({ claim_id }) => claim_id)))
    context.addIssue({
      code: "custom",
      path: ["claims"],
      message: "Manifest claims must be sorted by unique claim ID",
    });
  if (!isSortedUnique(manifest.skill_digests.map(({ skill_id }) => skill_id)))
    context.addIssue({
      code: "custom",
      path: ["skill_digests"],
      message: "Skill digests must be sorted by unique skill ID",
    });
  for (const [index, claim] of manifest.claims.entries())
    if (!isSortedUnique(claim.artifact_sha256s))
      context.addIssue({
        code: "custom",
        path: ["claims", index, "artifact_sha256s"],
        message: "Artifact digests must be sorted and unique",
      });
  const { manifest_id: manifestId, ...projection } = manifest;
  if (computeManifestId(projection) !== manifestId)
    context.addIssue({
      code: "custom",
      path: ["manifest_id"],
      message: "Completion manifest identifier does not match its content",
    });
};

/** Canonical immutable commitments for one verifier run. */
export const completionManifestSchema =
  completionManifestObjectSchema.superRefine(manifestIssues);

export type CompletionManifest = z.infer<typeof completionManifestSchema>;

/** Generated completion metadata derived from a verifier report. */
export interface CompletionLedgerArtifacts {
  readonly manifest: CompletionManifest;
  readonly ledger: EvidenceCompletionLedger;
}

const canonicalClaims = (
  claims: CompletionVerifierReport["claims"],
): CompletionVerifierReport["claims"] =>
  claims
    .map((claim) => ({
      ...claim,
      artifact_sha256s: [...claim.artifact_sha256s].sort(compareIdentifiers),
      evidence_ids: [...claim.evidence_ids].sort(compareIdentifiers),
    }))
    .sort((left, right) => compareIdentifiers(left.claim_id, right.claim_id));

/** Generate canonical manifest and ledger artifacts from live verifier output. */
export const createCompletionLedgerArtifacts = (
  input: unknown,
  skillDigests: readonly z.input<typeof skillDigestSchema>[],
): CompletionLedgerArtifacts => {
  const report = completionVerifierReportSchema.parse(input);
  const claims = canonicalClaims(report.claims);
  if (!isSortedUnique(claims.map(({ claim_id }) => claim_id)))
    throw new TypeError("Completion verifier claim IDs must be unique");
  for (const claim of claims) {
    if (!isSortedUnique(claim.artifact_sha256s))
      throw new TypeError("Artifact digests must be unique per claim");
    if (!isSortedUnique(claim.evidence_ids))
      throw new TypeError("Evidence IDs must be unique per claim");
  }
  const skills = skillDigests
    .map((skill) => skillDigestSchema.parse(skill))
    .sort((left, right) => compareIdentifiers(left.skill_id, right.skill_id));
  if (!isSortedUnique(skills.map(({ skill_id }) => skill_id)))
    throw new TypeError("Completion skill IDs must be unique");
  const projection = {
    schema_version: 1 as const,
    verifier: report.verifier,
    environment: report.environment,
    skill_digests: skills,
    claims: claims.map(
      ({ status: _status, evidence_ids: _evidenceIds, ...claim }) => claim,
    ),
  };
  return {
    manifest: completionManifestSchema.parse({
      ...projection,
      manifest_id: computeManifestId(projection),
    }),
    ledger: createEvidenceCompletionLedger(
      claims.map(({ claim_id, status, evidence_ids }) => ({
        claim_id,
        status,
        evidence_ids,
      })),
    ),
  };
};

/** Parse generated completion commitments and reject manual tampering. */
export const parseCompletionManifest = (input: unknown): CompletionManifest =>
  completionManifestSchema.parse(input);
