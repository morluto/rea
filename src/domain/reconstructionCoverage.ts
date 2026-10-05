import { createHash } from "node:crypto";

import canonicalize from "canonicalize";
import { z } from "zod";

import { evidenceBundleSchema, parseEvidenceBundle } from "./evidenceBundle.js";
import {
  evaluateReconstructionClaims,
  evaluateReconstructionPackageProofs,
  evaluateReconstructionSurfaces,
  evaluateReconstructionCoverageRisks,
  recommendedReconstructionProbes,
  type ReconstructionEvaluationContext,
} from "./reconstructionCoverageEvaluation.js";
import { digestSchema } from "./../domain/digests.js";
import { prefixedDigestSchema } from "./../domain/digests.js";

const evidenceIdSchema = prefixedDigestSchema("ev");
const stableIdSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9._:/-]{0,199}$/u);
const boundedTextSchema = z.string().trim().min(1);

const authoritySchema = z.enum([
  "observed",
  "derived",
  "inferred",
  "historical",
  "external",
]);

const artifactSchema = z.strictObject({
  artifact_id: stableIdSchema,
  artifact_sha256: digestSchema,
  version: z.string().trim().min(1),
  environment_sha256: digestSchema,
  evidence_ids: z.array(evidenceIdSchema).min(1),
});

const surfaceSchema = z.strictObject({
  surface_id: stableIdSchema,
  family: z.string().trim().min(1),
  artifact_id: stableIdSchema,
  occurrence_id: z.string().trim().min(1).nullable(),
  location: boundedTextSchema,
  authority: authoritySchema,
  dependency_surface_ids: z.array(stableIdSchema),
  evidence_ids: z.array(evidenceIdSchema).min(1),
});

const implementationOwnerSchema = z.strictObject({
  disposition: z.literal("implemented"),
  owner_path: boundedTextSchema,
  owner_export: z.string().trim().min(1).nullable(),
  owner_sha256: digestSchema,
  path_state: z.enum(["present", "missing", "unknown"]),
  package_state: z.enum(["distributed", "missing", "unknown"]),
  authority_route: z.enum(["none", "detected", "unknown"]),
});

const externalOwnerSchema = z.strictObject({
  disposition: z.enum(["external", "non-goal"]),
  rationale: boundedTextSchema,
});

const ownerSchema = z.strictObject({
  surface_id: stableIdSchema,
  ownership: z.discriminatedUnion("disposition", [
    implementationOwnerSchema,
    externalOwnerSchema,
  ]),
});

const claimSchema = z.strictObject({
  claim_id: stableIdSchema,
  title: z.string().trim().min(1),
  kind: z.string().trim().min(1),
  surface_ids: z.array(stableIdSchema).min(1),
  required_dimensions: z.array(stableIdSchema).min(1),
  required_authority: z.enum([
    "shipped-artifact",
    "controlled-replay",
    "live-observation",
    "external",
  ]),
});

const verifierContractBaseSchema = z.strictObject({
  verifier_id: stableIdSchema,
  claim_ids: z.array(stableIdSchema).min(1),
  dimensions: z.array(stableIdSchema).min(1),
  authority: z.enum([
    "shipped-artifact",
    "controlled-replay",
    "live-observation",
    "external",
  ]),
  max_age_ms: z.number().int().min(1),
  minimum_repeats: z.number().int().min(1),
  normalization_sha256: digestSchema,
  normalization_removes_dimensions: z.literal(false),
});

const verifierContractSchema = verifierContractBaseSchema.extend({
  contract_sha256: digestSchema,
});

const verifierResultSchema = z.strictObject({
  verifier_id: stableIdSchema,
  contract_sha256: digestSchema,
  observed_at: z.string().datetime({ offset: true }),
  status: z.enum([
    "pass",
    "fail",
    "unknown",
    "unsupported",
    "truncated",
    "skipped",
  ]),
  covered_claim_ids: z.array(stableIdSchema).min(1),
  covered_dimensions: z.array(stableIdSchema).min(1),
  artifact_sha256s: z.array(digestSchema).min(1),
  owner_sha256s: z.array(digestSchema),
  normalization_sha256: digestSchema,
  repeats: z.number().int().min(1),
  evidence_ids: z.array(evidenceIdSchema).min(1),
});

const contradictionSchema = z.strictObject({
  contradiction_id: stableIdSchema,
  status: z.enum(["active", "resolved"]),
  surface_ids: z.array(stableIdSchema),
  claim_ids: z.array(stableIdSchema),
  evidence_ids: z.array(evidenceIdSchema).min(2),
});

const packageProofSchema = z.strictObject({
  proof_id: stableIdSchema,
  kind: z.enum([
    "build",
    "clean-install",
    "package-contents",
    "runtime-routing",
    "authority-independence",
  ]),
  status: z.enum(["pass", "fail", "unknown", "unsupported", "skipped"]),
  artifact_sha256s: z.array(digestSchema).min(1),
  evidence_ids: z.array(evidenceIdSchema).min(1),
});

const boundarySchema = z.strictObject({
  boundary_id: stableIdSchema,
  title: z.string().trim().min(1),
  required_surface_ids: z.array(stableIdSchema).min(1),
  required_claim_ids: z.array(stableIdSchema).min(1),
  required_package_proof_kinds: z.array(packageProofSchema.shape.kind).min(1),
  allowed_dispositions: z.array(z.enum(["external", "non-goal"])),
  allowed_unknown_ids: z.array(stableIdSchema),
});

export const reconstructionCoverageDataSchema = z.strictObject({
  evidence_bundle: evidenceBundleSchema,
  artifacts: z.array(artifactSchema),
  surfaces: z.array(surfaceSchema),
  owners: z.array(ownerSchema),
  claims: z.array(claimSchema),
  verifier_contracts: z.array(verifierContractSchema),
  verifier_results: z.array(verifierResultSchema),
  residual_unknown_ids: z.array(stableIdSchema),
  contradictions: z.array(contradictionSchema),
  package_proofs: z.array(packageProofSchema),
  boundaries: z.array(boundarySchema),
});

export type ReconstructionCoverageData = z.infer<
  typeof reconstructionCoverageDataSchema
>;
export type ReconstructionVerifierContract = z.infer<
  typeof verifierContractSchema
>;

/** Parse inline coverage data and validate every evidence and authority link. */
export const createReconstructionCoverageData = (
  input: unknown,
): ReconstructionCoverageData => {
  const coverage = reconstructionCoverageDataSchema.parse(input);
  validateCoverageReferences(coverage);
  return coverage;
};

const closureReasonSchema = z.strictObject({
  code: z.enum([
    "surface-missing",
    "owner-missing",
    "owner-duplicate",
    "owner-path-missing",
    "owner-path-unknown",
    "owner-undistributed",
    "owner-distribution-unknown",
    "authority-routing-detected",
    "authority-routing-unknown",
    "disposition-not-allowed",
    "dependency-surface-missing",
    "claim-missing",
    "verifier-missing",
    "verifier-duplicate",
    "verifier-result-missing",
    "verifier-result-stale",
    "verifier-result-incompatible",
    "verifier-failed",
    "verifier-unknown",
    "active-unknown",
    "active-contradiction",
    "package-proof-missing",
    "package-proof-failed",
    "package-proof-unknown",
  ]),
  subject_id: stableIdSchema,
  detail: boundedTextSchema,
});

export const reconstructionClosureResultSchema = z.strictObject({
  boundary_id: stableIdSchema,
  status: z.enum(["partial", "failed", "unknown", "ready"]),
  summary: z.strictObject({
    required_surfaces: z.number().int().min(0),
    required_claims: z.number().int().min(0),
    reasons: z.number().int().min(0),
  }),
  reasons: z.array(closureReasonSchema),
  recommended_probes: z.array(
    z.strictObject({
      operation: stableIdSchema,
      subject_id: stableIdSchema,
      rationale: boundedTextSchema,
    }),
  ),
  evidence_ids: z.array(evidenceIdSchema),
});

export type ReconstructionClosureResult = z.infer<
  typeof reconstructionClosureResultSchema
>;

type CoverageData = z.infer<typeof reconstructionCoverageDataSchema>;
type ClosureReason = z.infer<typeof closureReasonSchema>;

/** Build a verifier contract whose digest prevents retrospective coverage edits. */
export const createReconstructionVerifierContract = (
  input: z.input<typeof verifierContractBaseSchema>,
): ReconstructionVerifierContract => {
  const parsed = verifierContractBaseSchema.parse(input);
  return verifierContractSchema.parse({
    ...parsed,
    contract_sha256: digest(parsed),
  });
};

/** Evaluate inline coverage data against one named fail-closed boundary. */
export const evaluateReconstructionClosure = (
  coverageInput: unknown,
  boundaryId: string,
  nowEpochMs: number,
): ReconstructionClosureResult => {
  const coverage = createReconstructionCoverageData(coverageInput);
  const boundary = coverage.boundaries.find(
    ({ boundary_id: id }) => id === boundaryId,
  );
  if (boundary === undefined)
    throw new TypeError(`Unknown reconstruction boundary: ${boundaryId}`);
  const context: ReconstructionEvaluationContext = {
    coverage,
    boundary,
    nowEpochMs,
    reasons: [],
    evidenceIds: new Set<string>(),
  };
  evaluateReconstructionSurfaces(context);
  evaluateReconstructionClaims(context);
  evaluateReconstructionCoverageRisks(context);
  evaluateReconstructionPackageProofs(context);
  const reasons = [...context.reasons].sort(reasonOrder);
  return reconstructionClosureResultSchema.parse({
    boundary_id: boundary.boundary_id,
    status: closureStatus(reasons),
    summary: {
      required_surfaces: boundary.required_surface_ids.length,
      required_claims: boundary.required_claim_ids.length,
      reasons: reasons.length,
    },
    reasons,
    recommended_probes: recommendedReconstructionProbes(reasons),
    evidence_ids: [...context.evidenceIds].sort(),
  });
};

const validateCoverageReferences = (workspace: CoverageData): void => {
  const evidenceBundle = parseEvidenceBundle(workspace.evidence_bundle);
  const evidenceIds = new Set(
    evidenceBundle.records.map(({ evidence_id: id }) => id),
  );
  const unknownIds = new Set(
    evidenceBundle.unknowns.map(({ unknown_id: id }) => id),
  );
  const artifacts = assertUnique(workspace.artifacts, "artifact_id");
  const surfaces = assertUnique(workspace.surfaces, "surface_id");
  const claims = assertUnique(workspace.claims, "claim_id");
  const contracts = assertUnique(workspace.verifier_contracts, "verifier_id");
  assertUnique(workspace.contradictions, "contradiction_id");
  assertUnique(workspace.package_proofs, "proof_id");
  assertUnique(workspace.boundaries, "boundary_id");
  for (const contract of workspace.verifier_contracts) {
    const { contract_sha256: contractSha256, ...base } = contract;
    if (contractSha256 !== digest(verifierContractBaseSchema.parse(base)))
      throw new TypeError(
        `Verifier contract digest is invalid: ${contract.verifier_id}`,
      );
  }
  for (const surface of workspace.surfaces)
    if (!artifacts.has(surface.artifact_id))
      throw new TypeError(`Surface artifact is missing: ${surface.surface_id}`);
  for (const owner of workspace.owners)
    if (!surfaces.has(owner.surface_id))
      throw new TypeError(`Owner surface is missing: ${owner.surface_id}`);
  for (const claim of workspace.claims)
    if (claim.surface_ids.some((id) => !surfaces.has(id)))
      throw new TypeError(`Claim surface is missing: ${claim.claim_id}`);
  for (const contract of workspace.verifier_contracts)
    if (contract.claim_ids.some((id) => !claims.has(id)))
      throw new TypeError(`Verifier claim is missing: ${contract.verifier_id}`);
  for (const result of workspace.verifier_results)
    if (!contracts.has(result.verifier_id))
      throw new TypeError(
        `Verifier result contract is missing: ${result.verifier_id}`,
      );
  const referencedEvidenceIds = [
    ...workspace.artifacts.flatMap(({ evidence_ids: ids }) => ids),
    ...workspace.surfaces.flatMap(({ evidence_ids: ids }) => ids),
    ...workspace.verifier_results.flatMap(({ evidence_ids: ids }) => ids),
    ...workspace.contradictions.flatMap(({ evidence_ids: ids }) => ids),
    ...workspace.package_proofs.flatMap(({ evidence_ids: ids }) => ids),
  ];
  const danglingEvidence = referencedEvidenceIds.find(
    (id) => !evidenceIds.has(id),
  );
  if (danglingEvidence !== undefined)
    throw new TypeError(
      `Coverage workspace Evidence is missing: ${danglingEvidence}`,
    );
  const danglingUnknown = workspace.residual_unknown_ids.find(
    (id) => !unknownIds.has(id),
  );
  if (danglingUnknown !== undefined)
    throw new TypeError(
      `Coverage workspace residual unknown is missing: ${danglingUnknown}`,
    );
};

const assertUnique = <Item extends Record<Key, string>, Key extends keyof Item>(
  items: readonly Item[],
  key: Key,
): Set<string> => {
  const values = items.map((item) => item[key]);
  if (new Set(values).size !== values.length)
    throw new TypeError(`Duplicate reconstruction coverage ${String(key)}`);
  return new Set(values);
};

const closureStatus = (
  reasons: readonly ClosureReason[],
): ReconstructionClosureResult["status"] => {
  if (reasons.length === 0) return "ready";
  if (
    reasons.some(({ code }) =>
      [
        "verifier-failed",
        "active-contradiction",
        "authority-routing-detected",
        "owner-path-missing",
        "owner-undistributed",
        "package-proof-failed",
      ].includes(code),
    )
  )
    return "failed";
  if (
    reasons.some(({ code }) =>
      [
        "verifier-result-stale",
        "verifier-result-incompatible",
        "verifier-unknown",
        "active-unknown",
        "owner-path-unknown",
        "owner-distribution-unknown",
        "authority-routing-unknown",
        "package-proof-unknown",
      ].includes(code),
    )
  )
    return "unknown";
  return "partial";
};

const reasonOrder = (left: ClosureReason, right: ClosureReason): number =>
  `${left.code}:${left.subject_id}`.localeCompare(
    `${right.code}:${right.subject_id}`,
  );

const digest = (value: unknown): string => {
  const encoded = canonicalize(value);
  if (encoded === undefined)
    throw new TypeError("Reconstruction coverage value is not canonical JSON");
  return createHash("sha256").update(encoded).digest("hex");
};
