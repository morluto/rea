import type {
  ReconstructionClosureResult,
  ReconstructionCoverageData,
  ReconstructionVerifierContract,
} from "./reconstructionCoverage.js";

export const recommendedReconstructionProbes = (
  reasons: readonly ClosureReason[],
): readonly { operation: string; subject_id: string; rationale: string }[] =>
  reasons.map((reason) => ({
    operation: probeOperation(reason.code),
    subject_id: reason.subject_id,
    rationale: reason.detail,
  }));

const probeOperation = (code: ClosureReason["code"]): string => {
  if (code.startsWith("owner-") || code.startsWith("authority-routing"))
    return "reconcile_reconstruction_owner";
  if (code.startsWith("verifier-")) return "run_reconstruction_verifier";
  if (code.startsWith("package-proof")) return "verify_reconstruction_package";
  if (code === "active-contradiction") return "resolve_contradiction";
  if (code === "active-unknown") return "probe_residual_unknown";
  return "update_authoritative_inventory";
};

type Boundary = ReconstructionCoverageData["boundaries"][number];
type ClosureReason = ReconstructionClosureResult["reasons"][number];
export interface ReconstructionEvaluationContext {
  readonly coverage: ReconstructionCoverageData;
  readonly boundary: Boundary;
  readonly nowEpochMs: number;
  readonly reasons: ClosureReason[];
  readonly evidenceIds: Set<string>;
}

export const evaluateReconstructionSurfaces = (
  context: ReconstructionEvaluationContext,
): void => {
  const surfaces = indexUnique(context.coverage.surfaces, "surface_id");
  for (const surfaceId of context.boundary.required_surface_ids) {
    const surface = surfaces.get(surfaceId);
    if (surface === undefined) {
      addReason(
        context,
        "surface-missing",
        surfaceId,
        "Required surface is absent from the authoritative inventory.",
      );
      continue;
    }
    addEvidence(context, surface.evidence_ids);
    for (const dependencyId of surface.dependency_surface_ids)
      if (!surfaces.has(dependencyId))
        addReason(
          context,
          "dependency-surface-missing",
          surfaceId,
          `Declared dependency surface is absent: ${dependencyId}`,
        );
    evaluateOwner(context, surfaceId);
  }
};

const evaluateOwner = (
  context: ReconstructionEvaluationContext,
  surfaceId: string,
): void => {
  const owners = context.coverage.owners.filter(
    ({ surface_id: id }) => id === surfaceId,
  );
  if (owners.length === 0) {
    addReason(
      context,
      "owner-missing",
      surfaceId,
      "Required surface has no reconstructed owner or explicit disposition.",
    );
    return;
  }
  if (owners.length > 1) {
    addReason(
      context,
      "owner-duplicate",
      surfaceId,
      "Required surface has conflicting ownership declarations.",
    );
    return;
  }
  const owner = owners[0]?.ownership;
  if (owner === undefined) return;
  if (owner.disposition !== "implemented") {
    if (!context.boundary.allowed_dispositions.includes(owner.disposition))
      addReason(
        context,
        "disposition-not-allowed",
        surfaceId,
        `${owner.disposition} is not allowed by this completion boundary.`,
      );
    return;
  }
  const ownerChecks: ReadonlyArray<
    readonly [boolean, ClosureReason["code"], string]
  > = [
    [
      owner.path_state === "missing",
      "owner-path-missing",
      "Declared owner path is missing.",
    ],
    [
      owner.path_state === "unknown",
      "owner-path-unknown",
      "Declared owner path has not been checked.",
    ],
    [
      owner.package_state === "missing",
      "owner-undistributed",
      "Declared owner is absent from the distributable.",
    ],
    [
      owner.package_state === "unknown",
      "owner-distribution-unknown",
      "Owner distribution state is unknown.",
    ],
    [
      owner.authority_route === "detected",
      "authority-routing-detected",
      "Reconstructed owner routes into the authority.",
    ],
    [
      owner.authority_route === "unknown",
      "authority-routing-unknown",
      "Authority independence has not been established.",
    ],
  ];
  for (const [matches, code, detail] of ownerChecks)
    if (matches) addReason(context, code, surfaceId, detail);
};

export const evaluateReconstructionClaims = (
  context: ReconstructionEvaluationContext,
): void => {
  const claims = indexUnique(context.coverage.claims, "claim_id");
  const indexes = createVerifierIndexes(context.coverage);
  for (const claimId of context.boundary.required_claim_ids) {
    const claim = claims.get(claimId);
    if (claim === undefined) {
      addReason(
        context,
        "claim-missing",
        claimId,
        "Required finite claim is absent.",
      );
      continue;
    }
    const contracts = indexes.contractsByClaim.get(claimId) ?? [];
    if (contracts.length === 0) {
      addReason(
        context,
        "verifier-missing",
        claimId,
        "No verifier contract covers this claim.",
      );
      continue;
    }
    if (contracts.length > 1) {
      addReason(
        context,
        "verifier-duplicate",
        claimId,
        "Multiple verifier contracts claim primary coverage.",
      );
      continue;
    }
    const contract = contracts[0];
    if (contract !== undefined)
      evaluateVerifierResult(context, claim, contract, indexes);
  }
};

interface VerifierIndexes {
  readonly contractsByClaim: ReadonlyMap<
    string,
    readonly ReconstructionVerifierContract[]
  >;
  readonly latestResultsByVerifier: ReadonlyMap<
    string,
    ReconstructionCoverageData["verifier_results"][number]
  >;
  readonly artifactDigests: ReadonlySet<string>;
  readonly ownerDigests: ReadonlySet<string>;
  readonly surfaces: ReadonlyMap<
    string,
    ReconstructionCoverageData["surfaces"][number]
  >;
  readonly artifacts: ReadonlyMap<
    string,
    ReconstructionCoverageData["artifacts"][number]
  >;
  readonly ownersBySurface: ReadonlyMap<
    string,
    readonly ReconstructionCoverageData["owners"][number][]
  >;
}

const createVerifierIndexes = (
  coverage: ReconstructionCoverageData,
): VerifierIndexes => {
  const contractsByClaim = new Map<string, ReconstructionVerifierContract[]>();
  for (const contract of coverage.verifier_contracts)
    for (const claimId of new Set(contract.claim_ids)) {
      const contracts = contractsByClaim.get(claimId) ?? [];
      contracts.push(contract);
      contractsByClaim.set(claimId, contracts);
    }

  const latestResultsByVerifier = new Map<
    string,
    ReconstructionCoverageData["verifier_results"][number]
  >();
  for (const result of coverage.verifier_results) {
    const latest = latestResultsByVerifier.get(result.verifier_id);
    // Stable descending sort used to choose the first input record on ties.
    if (
      latest === undefined ||
      Date.parse(result.observed_at) > Date.parse(latest.observed_at)
    )
      latestResultsByVerifier.set(result.verifier_id, result);
  }

  const ownersBySurface = new Map<
    string,
    ReconstructionCoverageData["owners"][number][]
  >();
  for (const owner of coverage.owners) {
    const owners = ownersBySurface.get(owner.surface_id) ?? [];
    owners.push(owner);
    ownersBySurface.set(owner.surface_id, owners);
  }

  return {
    contractsByClaim,
    latestResultsByVerifier,
    artifactDigests: new Set(
      coverage.artifacts.map(({ artifact_sha256: value }) => value),
    ),
    ownerDigests: new Set(
      coverage.owners.flatMap(({ ownership }) =>
        ownership.disposition === "implemented" ? [ownership.owner_sha256] : [],
      ),
    ),
    surfaces: indexUnique(coverage.surfaces, "surface_id"),
    artifacts: indexUnique(coverage.artifacts, "artifact_id"),
    ownersBySurface,
  };
};

const evaluateVerifierResult = (
  context: ReconstructionEvaluationContext,
  claim: ReconstructionCoverageData["claims"][number],
  contract: ReconstructionVerifierContract,
  indexes: VerifierIndexes,
): void => {
  const result = indexes.latestResultsByVerifier.get(contract.verifier_id);
  if (result === undefined) {
    addReason(
      context,
      "verifier-result-missing",
      claim.claim_id,
      "Verifier has no recorded result.",
    );
    return;
  }
  addEvidence(context, result.evidence_ids);
  if (!verifierResultIsCompatible(claim, contract, result, indexes)) {
    addReason(
      context,
      "verifier-result-incompatible",
      claim.claim_id,
      "Latest verifier result does not match current artifacts, owners, dimensions, authority, normalization, repeats, or contract.",
    );
    return;
  }
  const observedAt = Date.parse(result.observed_at);
  if (
    observedAt > context.nowEpochMs ||
    context.nowEpochMs - observedAt > contract.max_age_ms
  ) {
    addReason(
      context,
      "verifier-result-stale",
      claim.claim_id,
      "Latest compatible verifier result is stale.",
    );
    return;
  }
  if (result.status === "fail")
    addReason(
      context,
      "verifier-failed",
      claim.claim_id,
      "Latest compatible verifier result failed.",
    );
  else if (result.status !== "pass")
    addReason(
      context,
      "verifier-unknown",
      claim.claim_id,
      `Latest compatible verifier result is ${result.status}.`,
    );
};

const verifierResultIsCompatible = (
  claim: ReconstructionCoverageData["claims"][number],
  contract: ReconstructionVerifierContract,
  result: ReconstructionCoverageData["verifier_results"][number],
  indexes: VerifierIndexes,
): boolean => {
  const expectedArtifactDigests = claim.surface_ids.flatMap((surfaceId) => {
    const surface = indexes.surfaces.get(surfaceId);
    const artifact =
      surface === undefined
        ? undefined
        : indexes.artifacts.get(surface.artifact_id);
    return artifact === undefined ? [] : [artifact.artifact_sha256];
  });
  const expectedOwnerDigests = claim.surface_ids.flatMap((surfaceId) =>
    (indexes.ownersBySurface.get(surfaceId) ?? []).flatMap(({ ownership }) =>
      ownership.disposition === "implemented" ? [ownership.owner_sha256] : [],
    ),
  );
  return (
    result.contract_sha256 === contract.contract_sha256 &&
    result.normalization_sha256 === contract.normalization_sha256 &&
    result.covered_claim_ids.includes(claim.claim_id) &&
    result.covered_claim_ids.every((item) =>
      contract.claim_ids.includes(item),
    ) &&
    claim.required_dimensions.every((item) =>
      contract.dimensions.includes(item),
    ) &&
    claim.required_dimensions.every((item) =>
      result.covered_dimensions.includes(item),
    ) &&
    result.covered_dimensions.every((item) =>
      contract.dimensions.includes(item),
    ) &&
    result.artifact_sha256s.every((item) =>
      indexes.artifactDigests.has(item),
    ) &&
    expectedArtifactDigests.every((item) =>
      result.artifact_sha256s.includes(item),
    ) &&
    result.owner_sha256s.every((item) => indexes.ownerDigests.has(item)) &&
    expectedOwnerDigests.every((item) => result.owner_sha256s.includes(item)) &&
    result.repeats >= contract.minimum_repeats &&
    claim.required_authority === contract.authority
  );
};

export const evaluateReconstructionCoverageRisks = (
  context: ReconstructionEvaluationContext,
): void => {
  for (const unknownId of context.coverage.residual_unknown_ids)
    if (!context.boundary.allowed_unknown_ids.includes(unknownId))
      addReason(
        context,
        "active-unknown",
        unknownId,
        "Active residual unknown is not permitted by the completion boundary.",
      );
  for (const contradiction of context.coverage.contradictions)
    if (
      contradiction.status === "active" &&
      (contradiction.surface_ids.some((id) =>
        context.boundary.required_surface_ids.includes(id),
      ) ||
        contradiction.claim_ids.some((id) =>
          context.boundary.required_claim_ids.includes(id),
        ))
    ) {
      addEvidence(context, contradiction.evidence_ids);
      addReason(
        context,
        "active-contradiction",
        contradiction.contradiction_id,
        "Active contradiction affects the completion boundary.",
      );
    }
};

export const evaluateReconstructionPackageProofs = (
  context: ReconstructionEvaluationContext,
): void => {
  const surfaces = new Map(
    context.coverage.surfaces.map((surface) => [surface.surface_id, surface]),
  );
  const artifacts = new Map(
    context.coverage.artifacts.map((artifact) => [
      artifact.artifact_id,
      artifact,
    ]),
  );
  const requiredArtifactDigests = context.boundary.required_surface_ids.flatMap(
    (surfaceId) => {
      const surface = surfaces.get(surfaceId);
      const artifact =
        surface === undefined ? undefined : artifacts.get(surface.artifact_id);
      return artifact === undefined ? [] : [artifact.artifact_sha256];
    },
  );
  for (const kind of context.boundary.required_package_proof_kinds) {
    const proofs = context.coverage.package_proofs.filter(
      (proof) => proof.kind === kind,
    );
    const passing = proofs.find(
      ({ artifact_sha256s: digests, status }) =>
        status === "pass" &&
        requiredArtifactDigests.every((digest) => digests.includes(digest)),
    );
    if (passing !== undefined) {
      addEvidence(context, passing.evidence_ids);
      continue;
    }
    if (proofs.some(({ status }) => status === "fail"))
      addReason(
        context,
        "package-proof-failed",
        kind,
        "Required package or integration proof failed.",
      );
    else if (proofs.length > 0)
      addReason(
        context,
        "package-proof-unknown",
        kind,
        "Required package or integration proof is not passing.",
      );
    else
      addReason(
        context,
        "package-proof-missing",
        kind,
        "Required package or integration proof is missing.",
      );
  }
};

const indexUnique = <Item extends Record<Key, string>, Key extends keyof Item>(
  items: readonly Item[],
  key: Key,
): ReadonlyMap<string, Item> => new Map(items.map((item) => [item[key], item]));

const addReason = (
  context: ReconstructionEvaluationContext,
  code: ClosureReason["code"],
  subjectId: string,
  detail: string,
): void => {
  context.reasons.push({ code, subject_id: subjectId, detail });
};

const addEvidence = (
  context: ReconstructionEvaluationContext,
  evidenceIds: readonly string[],
): void => {
  for (const evidenceId of evidenceIds) context.evidenceIds.add(evidenceId);
};
