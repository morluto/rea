import { PROCESS_PROVIDER } from "./process/ProcessEvidence.js";
import {
  buildReconstructionObligationLedgerEvidenceValidated,
  resolveReconstructionObligationLedgerRequest,
} from "./ReconstructionObligationLedgerService.js";
import { EMPTY_PROCESS_CAPTURE_EXAMPLE } from "../domain/process/processCapture.fixture.js";
import { createEvidence, type Evidence } from "../domain/evidence.js";
import { createEvidenceBundle } from "../domain/evidenceBundle.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import { processCaptureSchema } from "../domain/process/processCapture.js";
import {
  reconstructionObligationLedgerSchema,
  type ReconstructionObligationLedgerInput,
  type ReconstructionObligationLedger,
  type ReviewedReconstructionObligation,
} from "../domain/reconstructionObligationLedgerSchemas.js";

/** Build controlled fixture Evidence used by reconstruction-ledger scenarios. */
export const proofEvidence = (id: string) =>
  createEvidence(
    undefined,
    { id: `fixture-${id}`, name: "Fixture verifier", version: "1" },
    {
      predicateType: "rea.fixture-verification",
      operation: "run_fixture_verifier",
      parameters: { id },
      result: { passed: true },
      confidence: "observed",
      authority: "controlled-replay",
    },
  );

/** Use the canonical empty process capture as a controlled Evidence example. */
export const processEvidence = () =>
  createEvidence(undefined, PROCESS_PROVIDER, {
    predicateType: "rea.process-capture",
    operation: "capture_process_scenario",
    parameters: {},
    result: jsonValueSchema.parse(
      processCaptureSchema.parse(EMPTY_PROCESS_CAPTURE_EXAMPLE),
    ),
    confidence: "observed",
    authority: "controlled-replay",
  });

/** Build verifier Evidence bound to enumerated fixture and obligation identities. */
export const boundProofEvidence = (
  id: string,
  result: {
    readonly obligation_ids: readonly string[];
    readonly fixture_ids: readonly string[];
    readonly case_kinds: readonly string[];
    readonly verifier_ids: readonly string[];
    readonly claim_ids: readonly string[];
  },
  authority: "shipped-artifact" | "controlled-replay" = "controlled-replay",
) =>
  createEvidence(
    undefined,
    { id: `proof-${id}`, name: "Reconstruction proof", version: "1" },
    {
      predicateType: "rea.reconstruction-proof",
      operation: "verify_reconstruction_obligations",
      parameters: {},
      result: {
        passed: true,
        obligation_ids: [...result.obligation_ids],
        fixture_ids: [...result.fixture_ids],
        case_kinds: [...result.case_kinds],
        verifier_ids: [...result.verifier_ids],
        claim_ids: [...result.claim_ids],
      },
      confidence: "observed",
      authority,
    },
  );

/** Build a ledger request with empty reviewed input and manifest defaults. */
export const request = (
  records: readonly Evidence[],
  overrides: Partial<ReconstructionObligationLedgerInput> = {},
): ReconstructionObligationLedgerInput => ({
  evidence_bundle: createEvidenceBundle(records),
  reviewed_obligations: [],
  manifest: { bindings: [], contradictions: [] },
  ...overrides,
});

/** Run request resolution, Evidence validation, and output parsing for a fixture. */
export const build = (
  input: ReconstructionObligationLedgerInput,
): ReconstructionObligationLedger => {
  const parsed = resolveReconstructionObligationLedgerRequest(input);
  if (!parsed.ok) throw parsed.error;
  const result = buildReconstructionObligationLedgerEvidenceValidated(
    parsed.value,
  );
  if (!result.ok) throw result.error;
  return reconstructionObligationLedgerSchema.parse(
    result.value.normalized_result,
  );
};

/** Create provenance for each required case from one source Evidence record. */
export const originalCases = (
  obligation: ReconstructionObligationLedger["obligations"][number],
  evidenceId: string,
) =>
  obligation.required_case_kinds.map((caseKind) => ({
    kind: caseKind,
    evidence_id: evidenceId,
    location: `/normalized_result/cases/${caseKind}`,
  }));

/** Create a minimal reviewed obligation for ledger closure scenarios. */
export const reviewedObligation = (
  obligationId: string,
  evidenceId: string,
): ReviewedReconstructionObligation => ({
  obligation_id: obligationId,
  obligation_version: 1,
  title: `Reviewed obligation ${obligationId}`,
  application_layer: "other",
  family: "reviewed",
  target: {
    artifact_sha256: null,
    application_node_id: null,
    semantic_node_id: null,
    location: `/reviewed/${obligationId}`,
  },
  required: true,
  required_case_kinds: ["positive"],
  required_original_authority: "static",
  required_fixture_authority: "unit",
  required_verifier_authority: "unit",
  requires_parser_type: false,
  dependency_obligation_ids: [],
  residual_unknown_ids: [],
  unavailable_authority: [],
  required_next_evidence: ["Bind an owner and verifier."],
  disposition: "active",
  review_evidence_ids: [evidenceId],
});
