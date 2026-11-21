import { isDeepStrictEqual } from "node:util";

import { evidenceFileTarget } from "./evidence.js";
import { z } from "zod";
import {
  ArtifactInventoryCarrierError,
  parseArtifactInventoryEvidence,
} from "./artifactInventoryEvidence.js";
import { compareArtifacts } from "./artifactComparison.js";
import { uniqueSorted } from "./canonicalOrdering.js";
import { compareUnicodeCodePoints } from "./unicodeCodePointOrder.js";
import { comparisonSourceEvidenceSides } from "./comparisonSourceEvidence.js";
import { readComparisonResult } from "./comparisonEvidenceResult.js";
import type { Evidence } from "./evidence.js";
import { hasComparisonEvidenceIdentity } from "./comparisonEvidenceIdentity.js";
import { readEvidenceBundle } from "./evidenceBundle.js";
import {
  AnalysisInputError,
  AnalysisResourceConstraintError,
  AnalysisUnsupportedTargetError,
} from "./analysisErrorCore.js";
import { EvidenceIntegrityError } from "./evidenceErrors.js";
import { analysisInputErrorFromIssues } from "./inputIssueProjection.js";
import { readEvidencePayload } from "./evidenceValidation.js";
import { functionDossierSchema } from "./native/functionDossier.js";
import { assessFunctionCallCoverage } from "./functionCallCoverage.js";
import {
  processCaptureSchema,
  type UnverifiedProcessCapture,
} from "./process/processCapture.js";
import { processSourceTruncated } from "./process/processCaptureCoverage.js";
import {
  PROCESS_COMPARISON_DIMENSIONS,
  type ProcessComparisonDimension,
} from "./process/processComparison.js";
import type { ProcessObservationSource } from "./process/processObservation.js";
import { digestCanonicalValue } from "./canonicalDigest.js";
import {
  countReconstructionClaimKinds,
  reconstructionClaimResultSchema,
  reconstructionClaimSelector,
  reconstructionSpecificationSchema,
  reconstructionVerificationResultSchema,
  type ReconstructionClaim as Claim,
  type ReconstructionClaimResult as ClaimResult,
  type ReconstructionObservedStatus as ObservedStatus,
  type ReconstructionVerificationResult,
} from "./reconstructionVerificationSchemas.js";
import {
  reconstructionClaimUnknowns,
  reconstructionProbes,
  reconstructionUnknownHeads,
} from "./reconstructionUnknowns.js";
import type { ResidualUnknown } from "./residualUnknown.js";
import { comparePngScreenshots } from "./pngVisualDiff.js";
import { webScreenshotSchema, type WebScreenshot } from "./webScreenshot.js";

const comparisonOperationsByClaimKind = {
  behavioral: "compare_process_captures",
  "structural-function": "compare_functions",
  "structural-artifact": "compare_artifacts",
  visual: "compare_web_screenshots",
} as const;

interface FunctionSourceFacts {
  readonly evidence_id: string;
  readonly callCoverageBlockers: readonly string[];
  readonly callCoverageDiagnostics: readonly string[];
}

interface ValidatedSourceFacts {
  readonly functions: readonly FunctionSourceFacts[];
  readonly processes: readonly {
    readonly evidence_id: string;
    readonly capture: UnverifiedProcessCapture;
  }[];
}

type ArtifactReplay = Pick<
  ReturnType<typeof compareArtifacts>,
  "status" | "left_manifest_id" | "right_manifest_id"
>;

/** Verify only explicitly declared claims; no global equivalence is inferred. */
export const verifyReconstruction = (
  specificationInput: unknown,
  bundleInput: unknown,
): ReconstructionVerificationResult => {
  const parsedSpecification =
    reconstructionSpecificationSchema.safeParse(specificationInput);
  if (!parsedSpecification.success)
    throw analysisInputErrorFromIssues(
      "verify_reconstruction",
      parsedSpecification.error.issues,
      specificationInput,
      { cause: parsedSpecification.error },
    );
  const specification = parsedSpecification.data;
  const bundleResult = readEvidenceBundle(bundleInput, {
    operation: "verify_reconstruction",
    path: ["evidence_bundle"],
  });
  if (!bundleResult.ok) throw bundleResult.error;
  const bundle = bundleResult.value;
  const records = new Map(
    bundle.records.map((item) => [item.evidence_id, item]),
  );
  const heads = reconstructionUnknownHeads(bundle.unknowns);
  const artifactReplays = new Map<string, ArtifactReplay>();
  const screenshots: ScreenshotAssessment = {
    captures: specification.claims.some(({ kind }) => kind === "visual")
      ? indexScreenshotCaptures(records.values())
      : new Map(),
    replayBlockers: new Map(),
  };
  const visualSelectors = new Set<string>();
  const results = specification.claims
    .map((claim, index) => {
      const result = evaluateClaim(
        claim,
        index,
        records,
        heads,
        artifactReplays,
        screenshots,
      );
      if (claim.kind === "visual") {
        // An inferred capture pair can resolve to the same selector as an explicit pair.
        const selector = reconstructionClaimSelector(claim, [
          result.left_evidence_ids[0]!,
          result.right_evidence_ids[0]!,
        ]);
        if (visualSelectors.has(selector))
          throw claimComparisonInputError(
            index,
            "Claim comparison selectors must be unique",
          );
        visualSelectors.add(selector);
      }
      return result;
    })
    .sort((left, right) =>
      compareUnicodeCodePoints(left.claim_id, right.claim_id),
    );
  const failed = count(results, "fail");
  const unresolved = count(results, "unknown");
  const probes = reconstructionProbes(results, heads);
  const evidenceLinks = uniqueSorted(
    results.flatMap(({ evidence_links: links }) => links),
  );
  const output = {
    status: failed > 0 ? "fail" : unresolved > 0 ? "unknown" : "pass",
    specification_sha256: digestCanonicalValue(
      {
        ...specification,
        claims: [...specification.claims].sort((left, right) =>
          compareUnicodeCodePoints(left.claim_id, right.claim_id),
        ),
      },
      "Reconstruction specification",
    ),
    summary: {
      total: results.length,
      passed: count(results, "pass"),
      failed,
      unknown: unresolved,
      ...countReconstructionClaimKinds(results),
    },
    claims: {
      items: results,
    },
    recommended_probes: probes,
    evidence_links: evidenceLinks,
    limitations: [
      "Pass means every declared claim passed; it does not establish global implementation equivalence.",
    ],
  };
  return reconstructionVerificationResultSchema.parse(output);
};

const evaluateClaim = (
  claim: Claim,
  claimIndex: number,
  records: ReadonlyMap<string, Evidence>,
  heads: ReadonlyMap<string, ResidualUnknown>,
  artifactReplays: Map<string, ArtifactReplay>,
  screenshots: ScreenshotAssessment,
): ClaimResult => {
  const comparison = records.get(claim.comparison_evidence_id);
  if (comparison === undefined)
    throw claimComparisonInputError(
      claimIndex,
      `Missing comparison Evidence ${claim.comparison_evidence_id}`,
    );
  validateComparisonIdentity(claim, comparison, claimIndex);
  const { sides, observation, visualBlockers } =
    claim.kind === "visual"
      ? assessScreenshotComparison(claim, comparison, screenshots)
      : {
          sides: comparisonSourceEvidenceSides(comparison),
          observation: comparisonObservation(claim, comparison),
          visualBlockers: [],
        };
  const allSourceIds = uniqueSorted([...sides.left, ...sides.right]);
  if (
    claim.kind !== "visual" &&
    !sameSet(comparison.evidence_links, allSourceIds)
  )
    throw new EvidenceIntegrityError(
      "Comparison Evidence closure disagrees with its parameters",
      {
        userMessage:
          "Comparison Evidence closure disagrees with its parameters",
      },
    );
  if (
    claim.kind === "visual" &&
    comparison.evidence_links.length > 0 &&
    !sameSet(comparison.evidence_links, allSourceIds)
  )
    throw new EvidenceIntegrityError(
      "Screenshot comparison Evidence links disagree with its artifact inputs",
      {
        userMessage:
          "Screenshot comparison Evidence links disagree with its artifact inputs",
      },
    );
  const sources = allSourceIds.map((id) => {
    const source = records.get(id);
    if (source === undefined)
      throw claimComparisonInputError(
        claimIndex,
        `Missing source Evidence ${id}`,
      );
    return source;
  });
  const sourceFacts =
    claim.kind === "visual"
      ? { functions: [], processes: [] }
      : readValidatedSourceFacts(claim, sources);
  const observed = observation.status;
  const callCoverage = sourceCallCoverage(
    claim,
    sourceFacts.functions,
    observation.hasIndependentFunctionChange === true,
  );
  const blockers = [
    ...authorityLimitations(claim, sources, sides),
    ...callCoverage.blockers,
    ...visualBlockers,
    ...sourceProcessCoverage(claim, sourceFacts.processes, observed),
    ...(claim.kind === "structural-artifact"
      ? assessArtifactSourceComparison(
          sides,
          records,
          comparison,
          observed,
          artifactReplays,
        )
      : []),
  ];
  const relevantUnknowns = reconstructionClaimUnknowns(
    heads,
    comparison.evidence_id,
    allSourceIds,
    observation.selectedDimensions ?? [claim.dimension],
  );
  const status = classify(observed, blockers, relevantUnknowns);
  return reconstructionClaimResultSchema.parse({
    claim_id: claim.claim_id,
    kind: claim.kind,
    dimension: claim.dimension,
    status,
    observed_status: observed,
    comparison_evidence_id: comparison.evidence_id,
    left_evidence_ids: sides.left,
    right_evidence_ids: sides.right,
    evidence_links: uniqueSorted([comparison.evidence_id, ...allSourceIds]),
    unknown_ids: relevantUnknowns.map(({ unknown_id: id }) => id),
    limitations: uniqueSorted([
      ...comparison.limitations,
      ...observation.limitations,
      ...blockers,
      ...callCoverage.diagnostics,
      ...relevantUnknowns.map(
        ({ question }) => `Residual unknown: ${question}`,
      ),
    ]),
  });
};

const screenshotComparisonParametersSchema = z.strictObject({
  before_artifact_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  after_artifact_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  channel_threshold: z.int().min(0).max(255),
  comparison_input_sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional(),
});

interface ScreenshotCapture {
  readonly evidenceId: string;
  readonly screenshot: WebScreenshot;
}

interface ScreenshotAssessment {
  readonly captures: ReadonlyMap<string, readonly ScreenshotCapture[]>;
  readonly replayBlockers: Map<string, string | null>;
}

const indexScreenshotCaptures = (records: Iterable<Evidence>) => {
  const captures = new Map<string, ScreenshotCapture[]>();
  for (const source of records) {
    if (
      source.operation !== "capture_web_screenshot" ||
      source.predicate_type !== "rea.web-screenshot"
    )
      continue;
    const parsed = readEvidencePayload(
      webScreenshotSchema,
      source.normalized_result,
      { within: ["normalized_result"] },
    );
    if (!parsed.ok) throw parsed.error;
    const sha256 = parsed.value.artifact.sha256;
    const capture = {
      evidenceId: source.evidence_id,
      screenshot: parsed.value,
    };
    const existing = captures.get(sha256);
    if (existing === undefined) captures.set(sha256, [capture]);
    else existing.push(capture);
  }
  return captures;
};

const assessScreenshotComparison = (
  claim: Extract<Claim, { kind: "visual" }>,
  comparison: Evidence,
  { captures, replayBlockers }: ScreenshotAssessment,
): {
  sides: { left: string[]; right: string[] };
  observation: ComparisonObservation;
  visualBlockers: string[];
} => {
  const parsed = readEvidencePayload(
    screenshotComparisonParametersSchema,
    comparison.parameters,
    { within: ["parameters"] },
  );
  if (!parsed.ok) throw parsed.error;
  const sourceForArtifact = (
    sha256: string,
    side: "before" | "after",
    evidenceId: string | undefined,
  ) => {
    const matches = captures.get(sha256);
    if (evidenceId !== undefined) {
      const selected = matches?.find((item) => item.evidenceId === evidenceId);
      if (selected !== undefined) return selected;
      const message = `Screenshot comparison ${side} capture Evidence does not match its artifact digest or is missing from the bundle (${evidenceId}).`;
      throw new EvidenceIntegrityError(message, { userMessage: message });
    }
    if (matches?.length !== 1) {
      const message = `Screenshot comparison ${side} artifact does not identify exactly one captured Evidence record. Supply both capture IDs in source_evidence when the digest is ambiguous.`;
      throw new EvidenceIntegrityError(message, { userMessage: message });
    }
    return matches[0]!;
  };
  const before = sourceForArtifact(
    parsed.value.before_artifact_sha256,
    "before",
    claim.source_evidence?.before_evidence_id,
  );
  const after = sourceForArtifact(
    parsed.value.after_artifact_sha256,
    "after",
    claim.source_evidence?.after_evidence_id,
  );
  const saved = readComparisonResult(comparison, "compare_web_screenshots");
  if (!saved.ok) throw saved.error;
  const { limitations, ...recorded } = saved.value.result;
  const visualBlockers: string[] = [];
  for (const { evidenceId, screenshot } of [before, after]) {
    const { status, conditions } = screenshot.completeness;
    if (
      status !== "complete_within_window" ||
      conditions.some((condition) => condition !== "complete_within_window")
    )
      visualBlockers.push(
        `Source ${evidenceId}: Screenshot coverage is incomplete (${uniqueSorted([status, ...conditions]).join(", ")}).`,
      );
  }
  // The comparison fixes both artifact digests and the threshold. Coverage
  // stays specific to the selected captures, while the pixel replay is reusable.
  let replayBlocker = replayBlockers.get(comparison.evidence_id);
  if (replayBlocker === undefined) {
    try {
      const { limitations: _limitations, ...replayed } = comparePngScreenshots({
        before: before.screenshot.artifact,
        after: after.screenshot.artifact,
        channel_threshold: parsed.value.channel_threshold,
      });
      replayBlocker = isDeepStrictEqual(recorded, replayed)
        ? null
        : "Retained screenshot pixels do not corroborate the recorded comparison.";
    } catch (cause) {
      if (
        !(cause instanceof TypeError) &&
        !(cause instanceof AnalysisResourceConstraintError) &&
        !(cause instanceof AnalysisUnsupportedTargetError)
      )
        throw cause;
      replayBlocker = `Retained screenshot comparison could not be replayed: ${cause.message}`;
    }
    replayBlockers.set(comparison.evidence_id, replayBlocker);
  }
  if (replayBlocker !== null) visualBlockers.push(replayBlocker);
  return {
    sides: { left: [before.evidenceId], right: [after.evidenceId] },
    observation: {
      status:
        recorded.status === "identical"
          ? "unchanged"
          : recorded.status === "different"
            ? "changed"
            : "unknown",
      limitations: [
        ...limitations,
        ...[before, after].flatMap(({ evidenceId, screenshot }) =>
          screenshot.limitations.map(
            (detail) => `Source ${evidenceId}: ${detail}`,
          ),
        ),
        ...(recorded.status === "dimension_mismatch"
          ? ["Screenshot dimensions differ."]
          : []),
      ],
    },
    visualBlockers,
  };
};

const assessArtifactSourceComparison = (
  sides: {
    readonly left: readonly string[];
    readonly right: readonly string[];
  },
  records: ReadonlyMap<string, Evidence>,
  comparison: Evidence,
  observed: ObservedStatus,
  replays: Map<string, ArtifactReplay>,
): string[] => {
  const parsed = readComparisonResult(comparison, "compare_artifacts");
  if (!parsed.ok) throw parsed.error;
  let leftManifest: string;
  let rightManifest: string;
  let corroborated = true;
  try {
    const left = sides.left.map((id) => records.get(id)!);
    const right = sides.right.map((id) => records.get(id)!);
    if (
      observed === "unchanged" ||
      observed === "changed" ||
      observed === "added" ||
      observed === "removed" ||
      observed === "contradiction"
    ) {
      const key = JSON.stringify([sides.left, sides.right]);
      let actual = replays.get(key);
      if (actual === undefined) {
        const result = compareArtifacts(left, right);
        actual = {
          status: result.status,
          left_manifest_id: result.left_manifest_id,
          right_manifest_id: result.right_manifest_id,
        };
        replays.set(key, actual);
      }
      leftManifest = actual.left_manifest_id;
      rightManifest = actual.right_manifest_id;
      corroborated = actual.status === observed;
    } else {
      leftManifest =
        parseArtifactInventoryEvidence(left).inventory.manifest.manifest_id;
      rightManifest =
        parseArtifactInventoryEvidence(right).inventory.manifest.manifest_id;
    }
  } catch (cause: unknown) {
    if (
      !(cause instanceof AnalysisInputError) &&
      !(cause instanceof ArtifactInventoryCarrierError)
    )
      throw cause;
    throw new EvidenceIntegrityError(cause.message, {
      cause,
      userMessage: cause.message,
    });
  }
  if (
    parsed.value.result.left_manifest_id !== leftManifest ||
    parsed.value.result.right_manifest_id !== rightManifest
  )
    throw new EvidenceIntegrityError(
      "Artifact comparison manifest identities disagree with its sources",
    );
  return corroborated
    ? []
    : [
        "Artifact source inventories do not corroborate the claimed comparison status.",
      ];
};

const readValidatedSourceFacts = (
  claim: Exclude<Claim, { kind: "visual" }>,
  sources: readonly Evidence[],
): ValidatedSourceFacts => {
  const isExpectedType = (source: Evidence): boolean => {
    if (claim.kind === "behavioral")
      return (
        source.operation === "capture_process_scenario" &&
        source.predicate_type === "rea.process-capture"
      );
    if (claim.kind === "structural-function")
      return (
        source.operation === "analyze_function" &&
        source.predicate_type === "rea.analysis"
      );
    return (
      (source.operation === "inventory_artifact" ||
        source.operation === "inspect_artifact") &&
      source.predicate_type === "rea.analysis"
    );
  };
  if (sources.some((source) => !isExpectedType(source)))
    throw new EvidenceIntegrityError(
      "Comparison source Evidence has an unexpected observation type",
      {
        userMessage:
          "Comparison source Evidence has an unexpected observation type",
      },
    );
  const functionSources: FunctionSourceFacts[] = [];
  const processSources: ValidatedSourceFacts["processes"][number][] = [];
  for (const source of sources) {
    if (claim.kind === "behavioral") {
      const capture = readEvidencePayload(
        processCaptureSchema,
        source.normalized_result,
        { within: ["normalized_result"] },
      );
      if (!capture.ok) throw capture.error;
      processSources.push({
        evidence_id: source.evidence_id,
        capture: capture.value,
      });
    } else if (claim.kind === "structural-function") {
      const parsedDossier = readEvidencePayload(
        functionDossierSchema,
        source.normalized_result,
        { within: ["normalized_result"] },
      );
      if (!parsedDossier.ok) throw parsedDossier.error;
      const dossier = parsedDossier.value;
      const callCoverage = assessFunctionCallCoverage(
        source.relationship_coverage,
        dossier,
      );
      functionSources.push({
        evidence_id: source.evidence_id,
        callCoverageBlockers: [
          ...callCoverage.blockers,
          ...callCoverage.discoveryLimitations,
        ],
        callCoverageDiagnostics: callCoverage.diagnostics,
      });
    } else {
      try {
        parseArtifactInventoryEvidence(source);
      } catch (cause: unknown) {
        if (cause instanceof EvidenceIntegrityError) throw cause;
        if (cause instanceof ArtifactInventoryCarrierError)
          throw new EvidenceIntegrityError(cause.message, {
            cause,
            userMessage: cause.message,
          });
        throw cause;
      }
    }
  }
  return { functions: functionSources, processes: processSources };
};

const validateComparisonIdentity = (
  claim: Claim,
  evidence: Evidence,
  claimIndex: number,
): void => {
  const expectedOperation = comparisonOperationsByClaimKind[claim.kind];
  if (evidence.operation !== expectedOperation)
    throw claimComparisonInputError(
      claimIndex,
      `Claim ${claim.claim_id} requires ${expectedOperation} Evidence; selected ${evidence.operation}`,
    );
  if (!hasComparisonEvidenceIdentity(evidence)) {
    const message = "Comparison Evidence identity or authority disagrees";
    throw new EvidenceIntegrityError(message, { userMessage: message });
  }
};

interface ComparisonObservation {
  readonly status: ObservedStatus;
  readonly limitations: readonly string[];
  readonly hasIndependentFunctionChange?: boolean;
  readonly selectedDimensions?: readonly string[];
}

const comparisonObservation = (
  claim: Exclude<Claim, { kind: "visual" }>,
  evidence: Evidence,
): ComparisonObservation => {
  if (claim.kind === "behavioral") {
    const parsed = readComparisonResult(evidence, "compare_process_captures");
    if (!parsed.ok) throw parsed.error;
    const result = parsed.value.result;
    if (claim.dimension !== "overall")
      return { status: result[claim.dimension], limitations: [] };
    if (
      result.status === "unchanged" &&
      result.first_divergence.status === "unknown"
    )
      return {
        status: "unknown",
        limitations: [result.first_divergence.reason],
      };
    return {
      status: result.status,
      limitations: [],
    };
  }
  if (claim.kind === "structural-function") {
    const parsed = readComparisonResult(evidence, "compare_functions");
    if (!parsed.ok) throw parsed.error;
    const result = parsed.value.result;
    if (claim.dimension === "overall")
      return {
        status: result.status,
        selectedDimensions: [
          "overall",
          ...result.dimensions.map(({ dimension }) => dimension),
        ],
        limitations: result.dimensions.flatMap(
          ({ limitations }) => limitations,
        ),
        // Historical overall changes can be caused only by incomplete call
        // sets. Ignore that aggregate change when independently checking the
        // source call-coverage limitations.
        hasIndependentFunctionChange:
          result.function_match.status === "mismatched" ||
          (result.function_match.status === "matched" &&
            result.dimensions.some(
              (dimension) =>
                dimension.dimension !== "calls" &&
                dimension.status === "changed",
            )),
      };
    const dimension = result.dimensions.find(
      (item) => item.dimension === claim.dimension,
    );
    if (dimension === undefined) {
      const message = "Function comparison dimension missing";
      throw new EvidenceIntegrityError(message, { userMessage: message });
    }
    return { status: dimension.status, limitations: dimension.limitations };
  }
  const parsed = readComparisonResult(evidence, "compare_artifacts");
  if (!parsed.ok) throw parsed.error;
  const result = parsed.value.result;
  return { status: result.status, limitations: [] };
};

const claimComparisonInputError = (claimIndex: number, message: string) =>
  new AnalysisInputError("verify_reconstruction", { userMessage: message }, [
    {
      path: ["claims", claimIndex, "comparison_evidence_id"],
      reason: "invalid_value",
      message,
    },
  ]);

const authorityLimitations = (
  claim: Claim,
  sources: readonly Evidence[],
  sides: {
    readonly left: readonly string[];
    readonly right: readonly string[];
  },
): string[] => {
  const requiredAuthority =
    claim.kind === "behavioral"
      ? "controlled-replay"
      : claim.kind === "visual"
        ? "external-service"
        : "shipped-artifact";
  const limitations: string[] = [];
  if (sides.left.some((id) => sides.right.includes(id)))
    limitations.push(
      "A source observation appears on both comparison sides; independent original and reconstruction observations are unavailable.",
    );
  if (
    sources.some(
      (source) =>
        source.authority !== requiredAuthority ||
        (claim.kind === "structural-function"
          ? source.confidence === "inferred"
          : source.confidence !== "observed"),
    )
  )
    limitations.push(
      `Source Evidence lacks qualifying ${requiredAuthority} authority.`,
    );
  if (
    (claim.kind === "structural-function" ||
      claim.kind === "structural-artifact") &&
    sources.some((source) => evidenceFileTarget(source) === undefined)
  )
    limitations.push("Structural source artifact identity is unavailable.");
  if (claim.kind === "behavioral") {
    const referenceEnvironment = sources[0]?.environment;
    if (
      referenceEnvironment === null ||
      referenceEnvironment === undefined ||
      sources.some(
        ({ environment }) =>
          environment === null ||
          JSON.stringify(environment) !== JSON.stringify(referenceEnvironment),
      )
    )
      limitations.push(
        "Controlled replay environments are unavailable or incompatible.",
      );
  }
  return limitations;
};

const processObservationSourceByDimension: Readonly<
  Record<ProcessComparisonDimension, ProcessObservationSource>
> = {
  terminal: "terminal_rendered",
  interaction: "interaction",
  exit: "lifecycle",
  filesystem: "filesystem",
  process: "process",
};

const sourceProcessCoverage = (
  claim: Claim,
  sources: ValidatedSourceFacts["processes"],
  observed: ObservedStatus,
): string[] => {
  if (
    claim.kind !== "behavioral" ||
    ["changed", "added", "removed", "contradiction"].includes(observed)
  )
    return [];
  const dimensions =
    claim.dimension === "overall"
      ? PROCESS_COMPARISON_DIMENSIONS
      : [claim.dimension];
  return sources.flatMap(({ evidence_id, capture }) =>
    dimensions.flatMap((dimension) =>
      processSourceTruncated(
        capture,
        processObservationSourceByDimension[dimension],
      )
        ? [
            `Source ${evidence_id}: ${dimension} observation coverage is incomplete.`,
          ]
        : [],
    ),
  );
};

const sourceCallCoverage = (
  claim: Claim,
  functionSources: readonly FunctionSourceFacts[],
  hasIndependentFunctionChange: boolean,
): { blockers: string[]; diagnostics: string[] } => {
  if (
    claim.kind !== "structural-function" ||
    (claim.dimension !== "calls" &&
      !(claim.dimension === "overall" && !hasIndependentFunctionChange))
  )
    return { blockers: [], diagnostics: [] };
  return {
    blockers: functionSources.flatMap(({ evidence_id, callCoverageBlockers }) =>
      callCoverageBlockers.map((reason) => `Source ${evidence_id}: ${reason}`),
    ),
    diagnostics: functionSources.flatMap(
      ({ evidence_id, callCoverageDiagnostics }) =>
        callCoverageDiagnostics.map(
          (reason) => `Source ${evidence_id}: ${reason}`,
        ),
    ),
  };
};

const classify = (
  observed: ObservedStatus,
  limitations: readonly string[],
  unknowns: readonly ResidualUnknown[],
): ClaimResult["status"] => {
  if (limitations.length > 0) return "unknown";
  if (["changed", "added", "removed", "contradiction"].includes(observed))
    return "fail";
  if (observed === "unknown" || observed === "truncated" || unknowns.length > 0)
    return "unknown";
  return "pass";
};

const count = (
  items: readonly ClaimResult[],
  status: ClaimResult["status"],
): number => items.filter((item) => item.status === status).length;
const sameSet = (left: readonly string[], right: readonly string[]): boolean =>
  uniqueSorted(left).length === uniqueSorted(right).length &&
  uniqueSorted(left).every((id, index) => id === uniqueSorted(right)[index]);
