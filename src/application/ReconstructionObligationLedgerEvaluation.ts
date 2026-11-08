import type { Evidence } from "../domain/evidence.js";
import type { ReconstructionObligationSources } from "./ReconstructionObligationLedgerRequest.js";
import {
  reconstructionObligationLedgerSchema,
  type ReconstructionObligation,
  type ReconstructionObligationLedger,
  type ReconstructionObligationManifest,
} from "../domain/reconstructionObligationLedgerSchemas.js";
import { digestCanonicalValue } from "../domain/canonicalDigest.js";
import {
  reconstructionObligationCoverage,
  reconstructionObligationDependencyGraph,
  reconstructionObligationLedgerClosureDigest,
  reconstructionObligationLedgerStatus,
  hasReconstructionObligationDiagnostic as hasDiagnostic,
  reconstructionObligationOwnershipGraph,
  reconstructionObligationReports,
  summarizeReconstructionObligations,
} from "../domain/reconstructionObligationLedgerIntegrity.js";
import {
  retiresObligation,
  type ReconstructionObligationCandidate,
} from "./ReconstructionObligationCandidates.js";
import {
  parseReconstructionProofEvidence,
  qualifyReconstructionProof,
  evidenceSupportsOriginalAuthority,
  proofAuthoritySatisfies,
} from "./ReconstructionObligationAuthority.js";
import {
  addObligationDiagnostic as addDiagnostic,
  contradictionDiagnostics,
  groupManifestBindings,
  groupManifestContradictions,
  uniqueObligationDiagnostics as uniqueDiagnostics,
} from "./ReconstructionObligationLedgerDiagnostics.js";
import {
  originalCaseDiagnostics,
  originalCasesFor,
} from "./ReconstructionObligationOriginalCases.js";
import { obligationLedgerEvidenceLinks } from "./ReconstructionObligationLedgerProjection.js";
import { uniqueSorted } from "../domain/canonicalOrdering.js";
import { compareUnicodeCodePoints } from "../domain/unicodeCodePointOrder.js";

type Diagnostic = ReconstructionObligation["diagnostics"][number];
type Binding = NonNullable<ReconstructionObligation["binding"]>;

/**
 * Generated obligations in one artifact that have neither runtime authority
 * nor a manifest binding. Above this count the artifact is reported as
 * over-generated: each such claim demands several fixtures and a verifier
 * before any evidence shows the boundary is reachable, so blind fixture work
 * would dominate the reconstruction and decoy boundaries in dead code could
 * absorb it. Hand-written preload or IPC surfaces rarely exceed this count;
 * larger applications first need runtime authority or reviewed dispositions.
 */
export const OBLIGATION_OVERGENERATION_THRESHOLD = 20;

interface EvaluationContext {
  readonly candidates: ReadonlyMap<string, ReconstructionObligationCandidate>;
  readonly evidence: ReadonlyMap<string, Evidence>;
  readonly proofs: ReadonlyMap<
    string,
    ReturnType<typeof parseReconstructionProofEvidence>
  >;
  readonly bindings: ReadonlyMap<string, readonly Binding[]>;
  readonly contradictions: ReturnType<typeof groupManifestContradictions>;
}

export const evaluateReconstructionObligationLedger = ({
  candidates: candidatesInput,
  sources,
  manifest,
  generationLimitations,
}: {
  readonly candidates: readonly ReconstructionObligationCandidate[];
  readonly sources: ReconstructionObligationSources;
  readonly manifest: ReconstructionObligationManifest;
  readonly generationLimitations: readonly string[];
}): ReconstructionObligationLedger => {
  const { bundle, records } = sources;
  const candidates = [...candidatesInput].sort((left, right) =>
    compareUnicodeCodePoints(left.obligation_id, right.obligation_id),
  );
  const orphanManifestIds = findOrphanManifestIds(candidates, manifest);
  const context = createEvaluationContext(candidates, records, manifest);
  const obligations = applyDependencyDiagnostics(
    candidates.map((candidate) => evaluateObligation(candidate, context)),
    context,
  );
  const ownershipGraph = reconstructionObligationOwnershipGraph(obligations);
  const dependencyGraph = reconstructionObligationDependencyGraph(obligations);
  const evidenceLinks = obligationLedgerEvidenceLinks(obligations, manifest);
  const limitations = ledgerLimitations(
    [...generationLimitations, ...overgenerationLimitations(obligations)],
    candidates.length,
    orphanManifestIds,
    evidenceLinks.filter((id) => !records.has(id)).length,
  );
  const coverage = reconstructionObligationCoverage(limitations);
  const semantic = {
    coverage,
    summary: summarizeReconstructionObligations(obligations),
    reports: reconstructionObligationReports(obligations),
    ownership_graph: ownershipGraph,
    dependency_graph: dependencyGraph,
    obligations,
    evidence_links: evidenceLinks,
    limitations,
  };
  const status = reconstructionObligationLedgerStatus(obligations, limitations);
  const closureDigest = reconstructionObligationLedgerClosureDigest({
    status,
    ...semantic,
  });
  return reconstructionObligationLedgerSchema.parse({
    schema: "ReconstructionObligationLedger",
    ledger_id: `rol_${digestCanonicalValue(
      {
        schema: "ReconstructionObligationLedger",
        evidence_ids: bundle.records.map(({ evidence_id: id }) => id),
        obligation_ids: obligations.map(({ obligation_id: id }) => id),
        closure_digest: closureDigest,
      },
      "Reconstruction obligation ledger",
    )}`,
    closure_digest: closureDigest,
    status,
    ...semantic,
  });
};

const createEvaluationContext = (
  candidates: readonly ReconstructionObligationCandidate[],
  evidence: ReadonlyMap<string, Evidence>,
  manifest: ReconstructionObligationManifest,
): EvaluationContext => ({
  candidates: new Map(
    candidates.map((candidate) => [candidate.obligation_id, candidate]),
  ),
  evidence,
  proofs: new Map(
    [...evidence].map(([id, record]) => [
      id,
      parseReconstructionProofEvidence(record),
    ]),
  ),
  bindings: groupManifestBindings(manifest),
  contradictions: groupManifestContradictions(manifest),
});

const findOrphanManifestIds = (
  candidates: readonly ReconstructionObligationCandidate[],
  manifest: ReconstructionObligationManifest,
): string[] => {
  const candidateIds = new Set(
    candidates.map(({ obligation_id: obligationId }) => obligationId),
  );
  return [
    ...new Set(
      [
        ...manifest.bindings.map(
          ({ obligation_id: obligationId }) => obligationId,
        ),
        ...manifest.contradictions.map(
          ({ obligation_id: obligationId }) => obligationId,
        ),
      ].filter((obligationId) => !candidateIds.has(obligationId)),
    ),
  ].sort();
};

const ledgerLimitations = (
  generationLimitations: readonly string[],
  candidateCount: number,
  orphanManifestIds: readonly string[],
  missingEvidenceCount: number,
): string[] =>
  [
    ...new Set([
      ...generationLimitations,
      ...(candidateCount === 0
        ? [
            "No reconstruction obligations were derived; closure cannot be claimed.",
          ]
        : []),
      ...(orphanManifestIds.length > 0
        ? [
            `Manifest entries reference unknown obligations: ${orphanManifestIds.join(", ")}.`,
          ]
        : []),
      ...(missingEvidenceCount > 0
        ? [
            `The ledger retains ${String(missingEvidenceCount)} Evidence reference(s) absent from the input bundle; closure cannot be claimed.`,
          ]
        : []),
    ]),
  ].sort();

/**
 * One artifact-level limitation per over-generated artifact. Every candidate
 * stays in the ledger; the limitation tells agents to stop fixture work on
 * static-only, unbound claims until authority or review narrows them.
 */
const overgenerationLimitations = (
  obligations: readonly ReconstructionObligation[],
): string[] => {
  const unboundByArtifact = new Map<string, ReconstructionObligation[]>();
  for (const obligation of obligations) {
    const sha256 = obligation.target.artifact_sha256;
    if (
      sha256 === null ||
      obligation.origin !== "generated" ||
      obligation.binding !== null ||
      obligation.source_state === "observed"
    )
      continue;
    unboundByArtifact.set(sha256, [
      ...(unboundByArtifact.get(sha256) ?? []),
      obligation,
    ]);
  }
  return [...unboundByArtifact]
    .filter(([, group]) => group.length > OBLIGATION_OVERGENERATION_THRESHOLD)
    .map(([sha256, group]) => {
      const retired = group.filter(
        ({ status }) => status === "out-of-scope",
      ).length;
      const unreviewed = group.length - retired;
      return `obligation-overgeneration: artifact ${sha256} has ${String(group.length)} generated obligations with no runtime authority and no manifest binding (families: ${uniqueSorted(group.map(({ family }) => family)).join(", ")}), above the threshold of ${String(OBLIGATION_OVERGENERATION_THRESHOLD)}; ${String(unreviewed)} still unreviewed, ${String(retired)} retired by reviewed disposition. Stop: do not write fixtures or verifiers for these candidates; obtain runtime authority for the artifact or record a reviewed disposition for each still-unreviewed decoy first.`;
    });
};

const evaluateObligation = (
  candidate: ReconstructionObligationCandidate,
  context: EvaluationContext,
): ReconstructionObligation => {
  const bindings = context.bindings.get(candidate.obligation_id) ?? [];
  const binding = bindings.length === 1 ? (bindings[0] ?? null) : null;
  const originalCases = originalCasesFor(candidate, binding);
  const diagnostics: Diagnostic[] = [];
  // A retired claim keeps its facts and contradictions visible but demands no
  // owner, fixture, original case, or authority; that work is not required.
  const retired = retiresObligation(candidate.disposition);
  if (candidate.definitionCount > 1)
    addDiagnostic(
      diagnostics,
      "duplicate-definition",
      "Multiple candidate definitions share this obligation ID.",
    );
  if (bindings.length === 0 && !retired)
    addDiagnostic(
      diagnostics,
      "missing-owner",
      "No reconstruction manifest binding owns this obligation.",
    );
  if (bindings.length > 1)
    addDiagnostic(
      diagnostics,
      "ambiguous-owner",
      "Multiple reconstruction manifest bindings claim this obligation.",
    );
  if (binding !== null && !retired)
    evaluateBinding(candidate, binding, context, diagnostics);
  if (!retired) {
    diagnostics.push(
      ...originalCaseDiagnostics(candidate, originalCases, context.evidence),
    );
    evaluateAuthority(candidate, originalCases, context, diagnostics);
  }
  evaluateDisposition(candidate, diagnostics);
  diagnostics.push(
    ...contradictionDiagnostics(
      candidate.obligation_id,
      context.contradictions,
      context.evidence,
    ),
  );
  for (const unknownId of candidate.residual_unknown_ids)
    addDiagnostic(
      diagnostics,
      "residual-unknown",
      `Residual unknown remains visible: ${unknownId}.`,
    );
  for (const unavailable of candidate.unavailable_authority)
    addDiagnostic(diagnostics, "unavailable-authority", unavailable);
  return {
    obligation_id: candidate.obligation_id,
    obligation_version: candidate.obligation_version,
    title: candidate.title,
    origin: candidate.origin,
    application_layer: candidate.application_layer,
    family: candidate.family,
    target: candidate.target,
    authority_references: candidate.authority_references,
    source_state: candidate.source_state,
    observed_cases: originalCases,
    required: candidate.required,
    required_case_kinds: candidate.required_case_kinds,
    required_original_authority: candidate.required_original_authority,
    required_fixture_authority: candidate.required_fixture_authority,
    required_verifier_authority: candidate.required_verifier_authority,
    requires_parser_type: candidate.requires_parser_type,
    dependency_obligation_ids: candidate.dependency_obligation_ids,
    residual_unknown_ids: candidate.residual_unknown_ids,
    unavailable_authority: candidate.unavailable_authority,
    required_next_evidence: candidate.required_next_evidence,
    binding,
    status: obligationStatus(candidate, binding, diagnostics),
    diagnostics: uniqueDiagnostics(diagnostics),
  };
};

const evaluateBinding = (
  candidate: ReconstructionObligationCandidate,
  binding: Binding,
  context: EvaluationContext,
  diagnostics: Diagnostic[],
): void => {
  if (candidate.requires_parser_type && binding.parser_type === null)
    addDiagnostic(
      diagnostics,
      "missing-parser-type",
      "This boundary requires an explicit parser, schema, and domain type.",
    );
  // Optional fixture kinds are retained and linked too, so their Evidence
  // references must resolve even though only required kinds close the claim.
  for (const fixture of binding.fixtures)
    for (const evidenceId of fixture.evidence_ids)
      if (!context.evidence.has(evidenceId))
        addDiagnostic(
          diagnostics,
          "missing-case",
          `${fixture.case_kind} fixture ${fixture.fixture_id} references Evidence ${evidenceId}, which is absent from the bundle.`,
        );
  for (const caseKind of candidate.required_case_kinds) {
    const fixtures = binding.fixtures.filter(
      ({ case_kind: fixtureCase }) => fixtureCase === caseKind,
    );
    if (fixtures.length === 0) {
      addDiagnostic(
        diagnostics,
        "missing-case",
        `Required ${caseKind} fixture is missing.`,
      );
      continue;
    }
    const qualifications = fixtures.map((fixture) => ({
      authoritySatisfied: proofAuthoritySatisfies(
        fixture.authority,
        candidate.required_fixture_authority,
      ),
      proofs: fixture.evidence_ids.map((id) => {
        const proof = context.proofs.get(id);
        return proof === undefined
          ? ({ ok: false, error: "missing-evidence" } as const)
          : qualifyReconstructionProof(proof, fixture.authority, {
              kind: "fixture",
              obligationId: candidate.obligation_id,
              obligationVersion: candidate.obligation_version,
              ownerSha256: binding.owner.owner_sha256,
              fixtureId: fixture.fixture_id,
              caseKind: fixture.case_kind,
            });
      }),
    }));
    if (
      qualifications.every(
        ({ authoritySatisfied, proofs }) =>
          authoritySatisfied && proofs.every((proof) => proof.ok),
      )
    )
      continue;
    const failures = qualifications.flatMap(({ proofs }) =>
      proofs.flatMap((proof) => (proof.ok ? [] : [proof.error])),
    );
    if (
      qualifications.some(({ authoritySatisfied }) => !authoritySatisfied) ||
      failures.includes("insufficient-authority")
    )
      addDiagnostic(
        diagnostics,
        "weak-fixture-authority",
        `${caseKind} fixture lacks ${candidate.required_fixture_authority} authority.`,
      );
    if (failures.length > 0)
      addDiagnostic(
        diagnostics,
        failures.includes("failed-proof")
          ? "fixture-failed"
          : "inapplicable-fixture-proof",
        `${caseKind} fixture proof qualification: ${[...new Set(failures)].sort().join(", ")}.`,
      );
  }
  evaluateVerifier(candidate, binding, context, diagnostics);
};

const evaluateVerifier = (
  candidate: ReconstructionObligationCandidate,
  binding: Binding,
  context: EvaluationContext,
  diagnostics: Diagnostic[],
): void => {
  const verifier = binding.verifier;
  if (verifier === null) {
    addDiagnostic(
      diagnostics,
      "missing-verifier",
      "No verifier claim is bound to this obligation.",
    );
    return;
  }
  if (!verifier.enumerated_obligation_ids.includes(candidate.obligation_id))
    addDiagnostic(
      diagnostics,
      "verifier-does-not-enumerate",
      "The verifier claim does not enumerate this obligation ID.",
    );
  const resultEvidence = context.evidence.get(verifier.result_evidence_id);
  if (resultEvidence === undefined)
    addDiagnostic(
      diagnostics,
      "missing-verifier-result",
      "The latest verifier result Evidence is absent from the bundle.",
    );
  if (
    !proofAuthoritySatisfies(
      verifier.authority,
      candidate.required_verifier_authority,
    )
  )
    addDiagnostic(
      diagnostics,
      "weak-verifier-authority",
      `Verifier authority does not satisfy ${candidate.required_verifier_authority}.`,
    );
  const proof = context.proofs.get(verifier.result_evidence_id);
  if (proof !== undefined) {
    const qualification = qualifyReconstructionProof(
      proof,
      verifier.authority,
      {
        kind: "verifier",
        obligationId: candidate.obligation_id,
        obligationVersion: candidate.obligation_version,
        ownerSha256: binding.owner.owner_sha256,
        verifierId: verifier.verifier_id,
        claimId: verifier.claim_id,
      },
    );
    if (!qualification.ok)
      addDiagnostic(
        diagnostics,
        qualification.error === "failed-proof"
          ? "verifier-failed"
          : qualification.error === "insufficient-authority"
            ? "weak-verifier-authority"
            : "inapplicable-verifier-proof",
        `Verifier proof qualification: ${qualification.error}.`,
      );
  }
  if (verifier.status !== "pass")
    addDiagnostic(
      diagnostics,
      verifier.status === "fail" ? "verifier-failed" : "verifier-unavailable",
      `Latest verifier status is ${verifier.status}.`,
    );
};

const evaluateAuthority = (
  candidate: ReconstructionObligationCandidate,
  originalCases: ReconstructionObligation["observed_cases"],
  context: EvaluationContext,
  diagnostics: Diagnostic[],
): void => {
  const referenceSatisfied = candidate.authority_references.some(
    (reference) => {
      const evidence = context.evidence.get(reference.evidence_id);
      return (
        evidence !== undefined &&
        (candidate.required_original_authority === "static"
          ? ["candidate", "observed"].includes(reference.state)
          : reference.state === "observed") &&
        evidenceSupportsOriginalAuthority(
          evidence,
          candidate.required_original_authority,
        )
      );
    },
  );
  const caseSatisfied = originalCases.some(({ evidence_id: evidenceId }) => {
    const evidence = context.evidence.get(evidenceId);
    return (
      evidence !== undefined &&
      evidenceSupportsOriginalAuthority(
        evidence,
        candidate.required_original_authority,
      )
    );
  });
  const satisfied = referenceSatisfied || caseSatisfied;
  if (!satisfied)
    addDiagnostic(
      diagnostics,
      "static-only",
      `No ${candidate.required_original_authority} authority characterizes the original finite behavior.`,
    );
};

const evaluateDisposition = (
  candidate: ReconstructionObligationCandidate,
  diagnostics: Diagnostic[],
): void => {
  if (candidate.disposition === "blocked")
    addDiagnostic(
      diagnostics,
      "blocked",
      "Reviewed disposition marks this obligation blocked.",
    );
  if (candidate.disposition === "out-of-scope")
    addDiagnostic(
      diagnostics,
      "out-of-scope",
      `Reviewed disposition marks this obligation out of scope; it remains visible.${retiredReason(candidate)}`,
    );
  if (candidate.disposition === "not-applicable")
    addDiagnostic(
      diagnostics,
      "not-applicable",
      `Reviewed disposition marks this obligation not applicable; it remains visible.${retiredReason(candidate)}`,
    );
};

const retiredReason = (candidate: ReconstructionObligationCandidate): string =>
  candidate.dispositionReason === null
    ? ""
    : ` Reason: ${candidate.dispositionReason}`;

const applyDependencyDiagnostics = (
  obligations: readonly ReconstructionObligation[],
  context: EvaluationContext,
): ReconstructionObligation[] => {
  let evaluated = [...obligations];
  for (let pass = 0; pass < obligations.length; pass += 1) {
    const statuses = new Map(
      evaluated.map(({ obligation_id: id, status }) => [id, status]),
    );
    let changed = false;
    evaluated = evaluated.map((obligation) => {
      const diagnostics = [...obligation.diagnostics];
      for (const dependencyId of obligation.dependency_obligation_ids) {
        const missing = !context.candidates.has(dependencyId);
        if (missing || statuses.get(dependencyId) !== "verified")
          addDiagnostic(
            diagnostics,
            missing ? "dependency-missing" : "dependency-open",
            `Dependency obligation is ${missing ? "missing" : "not verified"}: ${dependencyId}.`,
          );
      }
      const normalized = uniqueDiagnostics(diagnostics);
      const status = dependencyStatus(obligation.status, normalized);
      changed ||= status !== obligation.status;
      return { ...obligation, status, diagnostics: normalized };
    });
    if (!changed) break;
  }
  return evaluated;
};

const obligationStatus = (
  candidate: ReconstructionObligationCandidate,
  binding: Binding | null,
  diagnostics: readonly Diagnostic[],
): ReconstructionObligation["status"] => {
  if (
    hasDiagnostic(diagnostics, "out-of-scope") ||
    hasDiagnostic(diagnostics, "not-applicable")
  )
    return "out-of-scope";
  if (hasDiagnostic(diagnostics, "blocked")) return "blocked";
  if (hasDiagnostic(diagnostics, "contradiction")) return "contradicted";
  if (
    hasDiagnostic(diagnostics, "duplicate-definition") ||
    hasDiagnostic(diagnostics, "residual-unknown") ||
    hasDiagnostic(diagnostics, "unavailable-authority")
  )
    return "unknown";
  if (binding === null) return "unowned";
  if (diagnostics.length === 0) return "verified";
  return "implemented";
};

const dependencyStatus = (
  status: ReconstructionObligation["status"],
  diagnostics: readonly Diagnostic[],
): ReconstructionObligation["status"] =>
  (hasDiagnostic(diagnostics, "dependency-missing") ||
    hasDiagnostic(diagnostics, "dependency-open")) &&
  !["contradicted", "out-of-scope"].includes(status)
    ? "blocked"
    : status;
