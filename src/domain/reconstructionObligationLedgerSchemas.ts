import { z } from "zod";

import { evidenceBundleSchema } from "./evidenceBundle.js";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const evidenceIdSchema = z.string().regex(/^ev_[a-f0-9]{64}$/u);
const stableIdSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9._:/-]*$/u);
const textSchema = z.string().trim().min(1);

export const obligationStatusSchema = z.enum([
  "unowned",
  "characterized",
  "implemented",
  "verified",
  "contradicted",
  "blocked",
  "out-of-scope",
  "unknown",
]);

export const obligationLayerSchema = z.enum([
  "cli",
  "protocol",
  "electron",
  "persistence",
  "process",
  "runtime",
  "packaging",
  "native-abi",
  "application",
  "other",
]);

export const obligationCaseKindSchema = z.enum([
  "positive",
  "negative",
  "malformed",
  "cancellation",
  "teardown",
]);

export const obligationProofAuthoritySchema = z.enum([
  "unit",
  "integration",
  "protocol",
  "renderer",
  "packaged-process",
  "native-abi",
  "live-observation",
  "external",
]);

export const obligationOriginalAuthoritySchema = z.enum([
  "static",
  "runtime",
  "process",
  "external",
]);

const obligationTargetSchema = z.strictObject({
  artifact_sha256: digestSchema.nullable(),
  application_node_id: z
    .string()
    .regex(/^jag_node_[a-f0-9]{64}$/u)
    .nullable(),
  semantic_node_id: z
    .string()
    .regex(/^jsrg_node_[a-f0-9]{64}$/u)
    .nullable(),
  location: textSchema,
});

const authorityReferenceSchema = z.strictObject({
  evidence_id: evidenceIdSchema,
  authority: z.enum([
    "shipped-artifact",
    "controlled-replay",
    "historical-reference",
    "external-service",
    "analyst-inference",
  ]),
  state: z.enum(["candidate", "observed", "reviewed", "unknown"]),
  location: textSchema,
});

const observedCaseSchema = z.strictObject({
  kind: obligationCaseKindSchema,
  evidence_id: evidenceIdSchema,
  location: textSchema,
});

const ownerBindingSchema = z.strictObject({
  module_path: textSchema,
  symbol: textSchema,
  owner_sha256: digestSchema,
});

const parserTypeBindingSchema = z.strictObject({
  parser: textSchema,
  schema: textSchema,
  domain_type: textSchema,
});

const fixtureBindingSchema = z.strictObject({
  fixture_id: stableIdSchema,
  case_kind: obligationCaseKindSchema,
  authority: obligationProofAuthoritySchema,
  evidence_ids: z.array(evidenceIdSchema).min(1),
});

const nondeterminismSchema = z.strictObject({
  mode: z.enum(["total-order", "partial-order", "finite-traces"]),
  specification: textSchema,
});

const verifierBindingSchema = z.strictObject({
  verifier_id: stableIdSchema,
  claim_id: stableIdSchema,
  command: textSchema,
  authority: obligationProofAuthoritySchema,
  status: z.enum(["pass", "fail", "unknown", "unsupported", "skipped"]),
  result_evidence_id: evidenceIdSchema,
  enumerated_obligation_ids: z.array(stableIdSchema).min(1),
  nondeterminism: nondeterminismSchema,
});

export const reconstructionObligationManifestBindingSchema = z.strictObject({
  obligation_id: stableIdSchema,
  owner: ownerBindingSchema,
  parser_type: parserTypeBindingSchema.nullable(),
  original_cases: z.array(observedCaseSchema),
  fixtures: z.array(fixtureBindingSchema),
  verifier: verifierBindingSchema.nullable(),
});

export const reconstructionObligationManifestSchema = z.strictObject({
  bindings: z.array(reconstructionObligationManifestBindingSchema),
  contradictions: z.array(
    z.strictObject({
      obligation_id: stableIdSchema,
      evidence_ids: z.array(evidenceIdSchema).min(2),
    }),
  ),
});

export const reviewedReconstructionObligationSchema = z.strictObject({
  obligation_id: stableIdSchema,
  obligation_version: z.number().int().min(1),
  title: textSchema,
  application_layer: obligationLayerSchema,
  family: textSchema,
  target: obligationTargetSchema,
  required: z.boolean(),
  required_case_kinds: z.array(obligationCaseKindSchema).min(1),
  required_original_authority: obligationOriginalAuthoritySchema,
  required_fixture_authority: obligationProofAuthoritySchema,
  required_verifier_authority: obligationProofAuthoritySchema,
  requires_parser_type: z.boolean(),
  dependency_obligation_ids: z.array(stableIdSchema),
  residual_unknown_ids: z.array(stableIdSchema),
  unavailable_authority: z.array(textSchema),
  required_next_evidence: z.array(textSchema),
  disposition: z.enum(["active", "blocked", "out-of-scope"]),
  review_evidence_ids: z.array(evidenceIdSchema).min(1),
});

const diagnosticSchema = z.strictObject({
  code: z.enum([
    "duplicate-definition",
    "missing-owner",
    "ambiguous-owner",
    "missing-parser-type",
    "missing-original-case",
    "weak-original-case-authority",
    "missing-case",
    "weak-fixture-authority",
    "missing-verifier",
    "verifier-does-not-enumerate",
    "missing-verifier-result",
    "weak-verifier-authority",
    "verifier-failed",
    "static-only",
    "contradiction",
    "contradiction-evidence-missing",
    "residual-unknown",
    "dependency-missing",
    "dependency-open",
    "unavailable-authority",
    "blocked",
    "out-of-scope",
  ]),
  detail: textSchema,
});

export const reconstructionObligationSchema = z.strictObject({
  obligation_id: stableIdSchema,
  obligation_version: z.number().int().min(1),
  title: textSchema,
  origin: z.enum(["generated", "reviewed"]),
  application_layer: obligationLayerSchema,
  family: textSchema,
  target: obligationTargetSchema,
  authority_references: z.array(authorityReferenceSchema).min(1),
  source_state: z.enum(["candidate", "observed", "reviewed", "unknown"]),
  observed_cases: z.array(observedCaseSchema),
  required: z.boolean(),
  required_case_kinds: z.array(obligationCaseKindSchema).min(1),
  required_original_authority: obligationOriginalAuthoritySchema,
  required_fixture_authority: obligationProofAuthoritySchema,
  required_verifier_authority: obligationProofAuthoritySchema,
  requires_parser_type: z.boolean(),
  dependency_obligation_ids: z.array(stableIdSchema),
  residual_unknown_ids: z.array(stableIdSchema),
  unavailable_authority: z.array(textSchema),
  required_next_evidence: z.array(textSchema),
  binding: reconstructionObligationManifestBindingSchema.nullable(),
  status: obligationStatusSchema,
  diagnostics: z.array(diagnosticSchema),
});

const countBySchema = <Schema extends z.ZodType>(
  key: Schema,
): z.ZodArray<
  z.ZodObject<{
    key: Schema;
    count: z.ZodNumber;
  }>
> =>
  z.array(
    z.strictObject({
      key,
      count: z.number().int().min(0),
    }),
  );

export const reconstructionObligationLedgerSchema = z.strictObject({
  schema: z.literal("ReconstructionObligationLedger"),
  ledger_id: z.string().regex(/^rol_[a-f0-9]{64}$/u),
  closure_digest: digestSchema,
  status: z.enum(["ready", "open", "failed", "unknown"]),
  coverage: z.strictObject({
    status: z.enum(["complete", "partial"]),
  }),
  summary: z.strictObject({
    total: z.number().int().min(0),
    required: z.number().int().min(0),
    verified: z.number().int().min(0),
    required_open: z.number().int().min(0),
    by_status: countBySchema(obligationStatusSchema),
    by_application_layer: countBySchema(obligationLayerSchema),
    by_evidence_authority: countBySchema(
      z.enum(["candidate", "observed", "reviewed", "unknown"]),
    ),
  }),
  reports: z.strictObject({
    missing_owner_obligation_ids: z.array(stableIdSchema),
    missing_verifier_obligation_ids: z.array(stableIdSchema),
    contradicted_obligation_ids: z.array(stableIdSchema),
    residual_unknown_ids: z.array(stableIdSchema),
  }),
  ownership_graph: z.array(
    z.strictObject({
      obligation_id: stableIdSchema,
      module_path: textSchema,
      symbol: textSchema,
    }),
  ),
  dependency_graph: z.array(
    z.strictObject({
      obligation_id: stableIdSchema,
      depends_on_obligation_id: stableIdSchema,
    }),
  ),
  obligations: z.array(reconstructionObligationSchema),
  evidence_links: z.array(evidenceIdSchema),
  limitations: z.array(textSchema),
});

export const reconstructionObligationLedgerInputSchema = z.strictObject({
  evidence_bundle: evidenceBundleSchema,
  reviewed_obligations: z.array(reviewedReconstructionObligationSchema),
  manifest: reconstructionObligationManifestSchema,
});

export type ReconstructionObligation = z.infer<
  typeof reconstructionObligationSchema
>;
export type ReconstructionObligationLedger = z.infer<
  typeof reconstructionObligationLedgerSchema
>;
export type ReconstructionObligationLedgerInput = z.infer<
  typeof reconstructionObligationLedgerInputSchema
>;
export type ReviewedReconstructionObligation = z.infer<
  typeof reviewedReconstructionObligationSchema
>;
export type ReconstructionObligationManifest = z.infer<
  typeof reconstructionObligationManifestSchema
>;
