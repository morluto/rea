import type { Evidence } from "../domain/evidence.js";
import {
  parseEvidenceBundle,
  type EvidenceBundle,
} from "../domain/evidenceBundle.js";
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
import type { ReconstructionObligationCandidate } from "./ReconstructionObligationCandidates.js";
import {
  evidenceAuthoritySupportsProof,
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
import { compareUnicodeCodePoints } from "../domain/unicodeCodePointOrder.js";

type Diagnostic = ReconstructionObligation["diagnostics"][number];
type Binding = NonNullable<ReconstructionObligation["binding"]>;

interface EvaluationContext {
  readonly candidates: ReadonlyMap<string, ReconstructionObligationCandidate>;
  readonly evidence: ReadonlyMap<string, Evidence>;
  readonly bindings: ReadonlyMap<string, readonly Binding[]>;
  readonly contradictions: ReadonlyMap<string, readonly string[]>;
}

export const evaluateReconstructionObligationLedger = ({
  candidates: candidatesInput,
  bundle: bundleInput,
  manifest,
  generationLimitations,
}: {
  readonly candidates: readonly ReconstructionObligationCandidate[];
  readonly bundle: EvidenceBundle;
  readonly manifest: ReconstructionObligationManifest;
  readonly generationLimitations: readonly string[];
}): ReconstructionObligationLedger => {
  const bundle = parseEvidenceBundle(bundleInput);
  const allCandidates = [...candidatesInput].sort((left, right) =>
    compareUnicodeCodePoints(left.obligation_id, right.obligation_id),
  );
  const orphanManifestIds = findOrphanManifestIds(allCandidates, manifest);
  const candidates = allCandidates;
  const context = createEvaluationContext(candidates, bundle, manifest);
  const obligations = applyDependencyDiagnostics(
    candidates.map((candidate) => evaluateObligation(candidate, context)),
    context,
  );
  const ownershipGraph = reconstructionObligationOwnershipGraph(obligations);
  const dependencyGraph = reconstructionObligationDependencyGraph(obligations);
  const evidenceLinks = obligationLedgerEvidenceLinks(obligations, manifest);
  const limitations = ledgerLimitations(
    generationLimitations,
    allCandidates.length,
    orphanManifestIds,
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
  bundle: EvidenceBundle,
  manifest: ReconstructionObligationManifest,
): EvaluationContext => ({
  candidates: new Map(
    candidates.map((candidate) => [candidate.obligation_id, candidate]),
  ),
  evidence: new Map(
    bundle.records.map((evidence) => [evidence.evidence_id, evidence]),
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
    ]),
  ].sort();

const evaluateObligation = (
  candidate: ReconstructionObligationCandidate,
  context: EvaluationContext,
): ReconstructionObligation => {
  const bindings = context.bindings.get(candidate.obligation_id) ?? [];
  const binding = bindings.length === 1 ? (bindings[0] ?? null) : null;
  const diagnostics: Diagnostic[] = [];
  if (candidate.definitionCount > 1)
    addDiagnostic(
      diagnostics,
      "duplicate-definition",
      "Multiple candidate definitions share this obligation ID.",
    );
  if (bindings.length === 0)
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
  if (binding !== null)
    evaluateBinding(candidate, binding, context, diagnostics);
  diagnostics.push(
    ...originalCaseDiagnostics(candidate, binding, context.evidence),
  );
  evaluateAuthority(candidate, binding, context, diagnostics);
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
    observed_cases: originalCasesFor(candidate, binding),
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
    if (
      !fixtures.some(
        (fixture) =>
          proofAuthoritySatisfies(
            fixture.authority,
            candidate.required_fixture_authority,
          ) &&
          fixture.evidence_ids.every((id) => {
            const evidence = context.evidence.get(id);
            return (
              evidence !== undefined &&
              evidenceAuthoritySupportsProof(evidence, fixture.authority, {
                obligationId: candidate.obligation_id,
                fixtureId: fixture.fixture_id,
                caseKind: fixture.case_kind,
              })
            );
          }),
      )
    )
      addDiagnostic(
        diagnostics,
        "weak-fixture-authority",
        `${caseKind} fixture lacks ${candidate.required_fixture_authority} authority or authenticated Evidence.`,
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
    ) ||
    (resultEvidence !== undefined &&
      !evidenceAuthoritySupportsProof(resultEvidence, verifier.authority, {
        obligationId: candidate.obligation_id,
        verifierId: verifier.verifier_id,
        claimId: verifier.claim_id,
      }))
  )
    addDiagnostic(
      diagnostics,
      "weak-verifier-authority",
      `Verifier authority does not satisfy ${candidate.required_verifier_authority}.`,
    );
  if (verifier.status !== "pass")
    addDiagnostic(
      diagnostics,
      "verifier-failed",
      `Latest verifier status is ${verifier.status}.`,
    );
};

const evaluateAuthority = (
  candidate: ReconstructionObligationCandidate,
  binding: Binding | null,
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
  const caseSatisfied = originalCasesFor(candidate, binding).some(
    ({ evidence_id: evidenceId }) => {
      const evidence = context.evidence.get(evidenceId);
      return (
        evidence !== undefined &&
        evidenceSupportsOriginalAuthority(
          evidence,
          candidate.required_original_authority,
        )
      );
    },
  );
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
      "Reviewed disposition marks this obligation out of scope; it remains visible.",
    );
};

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
  if (hasDiagnostic(diagnostics, "out-of-scope")) return "out-of-scope";
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
