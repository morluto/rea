import {
  ANALYSIS_EVIDENCE_PREDICATE,
  evidenceFileTarget,
  type Evidence,
} from "./evidence.js";
import {
  sameTargetIdentity,
  type FileTargetIdentity,
} from "./targetIdentity.js";
import { AnalysisInputError } from "./analysisErrorCore.js";
import type { EvidenceIntegrityError } from "./evidenceErrors.js";
import {
  readEvidence,
  readEvidencePayload,
  type EvidenceSourceLocation,
} from "./evidenceValidation.js";
import type { JsonValue } from "./jsonValue.js";
import { err, ok, type Result } from "./result.js";
import { compareUnicodeCodePoints } from "./unicodeCodePointOrder.js";
import {
  functionDossierSchema,
  type FunctionDossier,
} from "./native/functionDossier.js";
import { assessFunctionCallCoverage } from "./functionCallCoverage.js";
import { functionCoordinateContextsEqual } from "./native/functionCoordinateContext.js";

/** Complete function observation parsed from one analyze_function Evidence record. */
export interface FunctionSnapshot {
  readonly evidence: Evidence;
  /** The file the function was analysed in, selection included. */
  readonly target: FileTargetIdentity;
  readonly dossier: FunctionDossier;
  readonly limitations: readonly string[];
  readonly callCoverageBlockers: readonly string[];
  readonly unresolvedCallCaveats: readonly string[];
  readonly callCoverageDiagnostics: readonly string[];
  readonly callDiscoveryLimitations: readonly string[];
  readonly callDiscoveryStatus: "complete" | "partial" | "unknown";
}

/** Artifact identity and provider-owned mapping jointly establish coordinate applicability. */
export type FunctionSnapshotCoordinateContext =
  | "common"
  | "cross-artifact"
  | "unknown";

export const functionSnapshotCoordinateContext = (
  left: FunctionSnapshot,
  right: FunctionSnapshot,
): FunctionSnapshotCoordinateContext => {
  if (left.target.sha256 !== right.target.sha256) return "cross-artifact";
  // The same bytes share coordinates only when opened as the same target:
  // format, architecture and selection (a raw entry point or flash offset).
  return left.target.architecture !== null &&
    sameTargetIdentity(left.target, right.target) &&
    functionCoordinateContextsEqual(
      left.evidence.analysis_profile,
      right.evidence.analysis_profile,
    )
    ? "common"
    : "unknown";
};

/** Parse one complete analyze_function Evidence record for comparison workflows. */
export const parseFunctionEvidence = (
  input: unknown,
  selection: {
    readonly operation: "compare_functions" | "build_call_path";
    readonly path: readonly (string | number)[];
  },
): Result<FunctionSnapshot, AnalysisInputError | EvidenceIntegrityError> => {
  const [first] = selection.path;
  const side: Pick<EvidenceSourceLocation, "side"> =
    selection.path.length === 1 && (first === "left" || first === "right")
      ? { side: first }
      : {};
  const parsed = readEvidence(input, side);
  if (!parsed.ok) return parsed;
  const evidence = parsed.value;
  const invalidSelection = (
    message: string,
    facts?: { readonly expected: JsonValue; readonly observed: JsonValue },
  ) =>
    err(
      new AnalysisInputError(selection.operation, { userMessage: message }, [
        {
          path: selection.path,
          reason: "invalid_value",
          message,
          ...facts,
        },
      ]),
    );
  if (
    evidence.operation !== "analyze_function" ||
    evidence.predicate_type !== ANALYSIS_EVIDENCE_PREDICATE
  ) {
    const location = selection.path.map(String).join(".");
    const subject =
      location === ""
        ? "supplied Evidence"
        : selection.path.length === 1
          ? `${location} Evidence`
          : `Evidence at ${location}`;
    return invalidSelection(
      `Function analysis requires analyze_function Evidence with the rea.analysis predicate; the ${subject} has operation ${evidence.operation} and predicate ${evidence.predicate_type}.`,
      {
        expected: {
          operation: "analyze_function",
          predicate_type: ANALYSIS_EVIDENCE_PREDICATE,
        },
        observed: {
          operation: evidence.operation,
          predicate_type: evidence.predicate_type,
        },
      },
    );
  }
  const target = evidenceFileTarget(evidence);
  if (target === undefined)
    return invalidSelection(
      "Function analysis requires artifact-bound Evidence",
    );
  const dossier = readEvidencePayload(
    functionDossierSchema,
    evidence.normalized_result,
    { ...side, within: ["normalized_result"] },
  );
  if (!dossier.ok) return dossier;
  const callCoverage = assessFunctionCallCoverage(
    evidence.relationship_coverage,
    dossier.value,
  );
  return ok({
    evidence,
    target,
    dossier: dossier.value,
    limitations: [
      ...new Set([...evidence.limitations, ...dossier.value.limitations]),
    ].sort((left, right) => compareUnicodeCodePoints(left, right)),
    callCoverageBlockers: callCoverage.blockers,
    unresolvedCallCaveats: callCoverage.unresolvedCallCaveats,
    callCoverageDiagnostics: callCoverage.diagnostics,
    callDiscoveryLimitations: callCoverage.discoveryLimitations,
    callDiscoveryStatus: callCoverage.discoveryStatus,
  });
};
