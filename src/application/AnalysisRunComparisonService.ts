import {
  type AnalysisRunComparisonReport,
  type AnalysisRunCoverage,
  type AnalysisRunEnvelope,
  analysisRunEnvelopeSchema,
  type AnalysisRunFindingRecord,
  type AnalysisRunIncompatibility,
  type AnalysisRunObligationRecord,
  type AnalysisRunProcedureRecord,
  type AnalysisRunUnknownRecord,
  type CompareAnalysisRunsOptions,
  compareAnalysisRuns,
  compareCompatibleAnalysisRuns,
  type SupportedAnalysisRunResultType,
} from "../domain/analysisRunComparison.js";
import { digestCanonicalValue } from "../domain/canonicalDigest.js";
import { compareUnicodeCodePoints } from "../domain/unicodeCodePointOrder.js";
import { type Evidence, parseEvidence } from "../domain/evidence.js";
import {
  type EvidenceBundle,
  parseEvidenceBundle,
} from "../domain/evidenceBundle.js";
import { jsonObjectSchema } from "../domain/jsonValue.js";
import type { Result } from "../domain/result.js";

const VALID_SEVERITIES = new Set(["info", "low", "medium", "high", "critical"]);
const VALID_CONFIDENCES = new Set(["inferred", "derived", "observed"]);
const VALID_OBLIGATION_STATUSES = new Set([
  "verified",
  "open",
  "unsatisfied",
  "contradicted",
]);

const inferResultTypeFromOperation = (
  operation: string,
): SupportedAnalysisRunResultType => {
  if (operation.includes("function") || operation === "decompile") {
    return "function-analysis";
  }
  if (operation.includes("application") || operation.includes("bundle")) {
    return "application-analysis";
  }
  if (operation.startsWith("inspect")) {
    return "artifact-inspection";
  }
  return "binary-analysis";
};

const parseStrictStringArray = (val: unknown, fieldName: string): string[] => {
  if (val === undefined) return [];
  if (!Array.isArray(val)) {
    throw new TypeError(`Invalid ${fieldName}: expected array of strings`);
  }
  return val.map((entry) => {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new TypeError(
        `Invalid ${fieldName} element: expected non-empty string`,
      );
    }
    return entry;
  });
};

const parseNullableString = (
  val: unknown,
  fieldName: string,
): string | null => {
  if (val === undefined || val === null) return null;
  if (typeof val !== "string") {
    throw new TypeError(`Invalid ${fieldName}: expected string or null`);
  }
  return val;
};

const parseNullableNonNegInt = (
  val: unknown,
  fieldName: string,
): number | null => {
  if (val === undefined || val === null) return null;
  if (typeof val !== "number" || !Number.isInteger(val) || val < 0) {
    throw new TypeError(
      `Invalid ${fieldName}: expected non-negative integer or null`,
    );
  }
  return val;
};

const extractProcedureEntry = (
  entry: unknown,
  defaultEvidenceId: string,
): AnalysisRunProcedureRecord => {
  if (typeof entry !== "object" || entry === null) {
    throw new TypeError("Invalid procedure entry: expected object");
  }
  const item = entry as Record<string, unknown>;
  if (typeof item.address !== "string" || typeof item.name !== "string") {
    throw new TypeError(
      "Invalid procedure entry: address and name must be strings",
    );
  }
  return {
    address: item.address,
    name: item.name,
    signature: parseNullableString(item.signature, "procedure.signature"),
    size_bytes: parseNullableNonNegInt(item.size_bytes, "procedure.size_bytes"),
    callees: parseStrictStringArray(item.callees, "procedure.callees"),
    callers: parseStrictStringArray(item.callers, "procedure.callers"),
    pseudocode_sha256: parseNullableString(
      item.pseudocode_sha256,
      "procedure.pseudocode_sha256",
    ),
    evidence_id: defaultEvidenceId,
    ...(typeof item.metadata === "object" && item.metadata !== null
      ? { metadata: jsonObjectSchema.parse(item.metadata) }
      : {}),
  };
};

const extractFindingEntry = (
  entry: unknown,
  defaultEvidenceId: string,
): AnalysisRunFindingRecord => {
  if (typeof entry !== "object" || entry === null) {
    throw new TypeError("Invalid finding entry: expected object");
  }
  const item = entry as Record<string, unknown>;
  if (
    typeof item.finding_id !== "string" ||
    typeof item.category !== "string" ||
    typeof item.title !== "string" ||
    typeof item.summary !== "string"
  ) {
    throw new TypeError(
      "Invalid finding entry: finding_id, category, title, and summary must be strings",
    );
  }
  if (
    typeof item.severity !== "string" ||
    !VALID_SEVERITIES.has(item.severity)
  ) {
    throw new TypeError(
      `Invalid finding severity for ${item.finding_id}: ${String(item.severity)}`,
    );
  }
  if (
    typeof item.confidence !== "string" ||
    !VALID_CONFIDENCES.has(item.confidence)
  ) {
    throw new TypeError(
      `Invalid finding confidence for ${item.finding_id}: ${String(item.confidence)}`,
    );
  }
  return {
    finding_id: item.finding_id,
    category: item.category,
    severity: item.severity as AnalysisRunFindingRecord["severity"],
    confidence: item.confidence as AnalysisRunFindingRecord["confidence"],
    title: item.title,
    summary: item.summary,
    locations: parseStrictStringArray(item.locations, "finding.locations"),
    evidence_id: defaultEvidenceId,
    ...(typeof item.attributes === "object" && item.attributes !== null
      ? { attributes: jsonObjectSchema.parse(item.attributes) }
      : {}),
    ...(typeof item.metadata === "object" && item.metadata !== null
      ? { metadata: jsonObjectSchema.parse(item.metadata) }
      : {}),
  };
};

const extractObligationEntry = (
  entry: unknown,
  defaultEvidenceId: string,
): AnalysisRunObligationRecord => {
  if (typeof entry !== "object" || entry === null) {
    throw new TypeError("Invalid obligation entry: expected object");
  }
  const item = entry as Record<string, unknown>;
  if (
    typeof item.obligation_id !== "string" ||
    typeof item.category !== "string" ||
    typeof item.description !== "string" ||
    typeof item.status !== "string" ||
    !VALID_OBLIGATION_STATUSES.has(item.status)
  ) {
    throw new TypeError("Invalid obligation entry fields");
  }
  const explicitEvidenceIds = parseStrictStringArray(
    item.evidence_ids,
    "obligation.evidence_ids",
  );
  return {
    obligation_id: item.obligation_id,
    category: item.category,
    description: item.description,
    status: item.status as AnalysisRunObligationRecord["status"],
    evidence_ids: [
      ...new Set([defaultEvidenceId, ...explicitEvidenceIds]),
    ].sort(compareUnicodeCodePoints),
    ...(typeof item.metadata === "object" && item.metadata !== null
      ? { metadata: jsonObjectSchema.parse(item.metadata) }
      : {}),
  };
};

const extractStructuredItemsFromNormalizedResult = (
  normalizedResult: unknown,
  defaultEvidenceId: string,
): {
  readonly procedures: AnalysisRunProcedureRecord[];
  readonly findings: AnalysisRunFindingRecord[];
  readonly obligations: AnalysisRunObligationRecord[];
  readonly unknowns: AnalysisRunUnknownRecord[];
} => {
  if (typeof normalizedResult !== "object" || normalizedResult === null) {
    return { procedures: [], findings: [], obligations: [], unknowns: [] };
  }
  const record = normalizedResult as Record<string, unknown>;
  const rawProcedures = Object.hasOwn(record, "procedures")
    ? record.procedures
    : Object.hasOwn(record, "functions")
      ? record.functions
      : [];
  const rawFindings = Object.hasOwn(record, "findings") ? record.findings : [];
  const rawObligations = Object.hasOwn(record, "obligations")
    ? record.obligations
    : [];

  if (!Array.isArray(rawProcedures)) {
    throw new TypeError("normalized_result.procedures must be an array");
  }
  if (!Array.isArray(rawFindings)) {
    throw new TypeError("normalized_result.findings must be an array");
  }
  if (!Array.isArray(rawObligations)) {
    throw new TypeError("normalized_result.obligations must be an array");
  }

  return {
    procedures: rawProcedures.map((e) =>
      extractProcedureEntry(e, defaultEvidenceId),
    ),
    findings: rawFindings.map((e) => extractFindingEntry(e, defaultEvidenceId)),
    obligations: rawObligations.map((e) =>
      extractObligationEntry(e, defaultEvidenceId),
    ),
    unknowns: [],
  };
};

const mapEvidenceCoverage = (
  coverage: Evidence["relationship_coverage"],
): AnalysisRunCoverage | null =>
  coverage === null
    ? null
    : {
        status: coverage.status,
        ...(coverage.status === "partial"
          ? { limitations: [...coverage.limitations] }
          : {}),
        ...(coverage.status === "unknown" ? { reason: coverage.reason } : {}),
      };

/**
 * Project an authenticated REA `Evidence` record into an `AnalysisRunEnvelope`
 * without mutating the source record.
 */
export const projectEvidenceToAnalysisRun = (
  evidenceInput: Evidence,
  resultTypeOverride?: SupportedAnalysisRunResultType,
): AnalysisRunEnvelope => {
  const evidence = parseEvidence(evidenceInput);
  const extracted = extractStructuredItemsFromNormalizedResult(
    evidence.normalized_result,
    evidence.evidence_id,
  );
  return analysisRunEnvelopeSchema.parse({
    run_id: evidence.evidence_id,
    evidence_id: evidence.evidence_id,
    result_type:
      resultTypeOverride ?? inferResultTypeFromOperation(evidence.operation),
    operation: evidence.operation,
    predicate_type: evidence.predicate_type,
    subject:
      evidence.subject === null
        ? null
        : {
            sha256: evidence.subject.digest.sha256,
            format: evidence.subject.format,
            architecture: evidence.subject.architecture,
            local_path: evidence.subject.local_path,
          },
    provider: {
      id: evidence.provider.id,
      name: evidence.provider.name,
      version: evidence.provider.version,
    },
    relationship_coverage: mapEvidenceCoverage(evidence.relationship_coverage),
    procedures: extracted.procedures,
    findings: extracted.findings,
    obligations: extracted.obligations,
    unknowns: extracted.unknowns,
    limitations: [...evidence.limitations],
  });
};

const putConflictCheckedItem = <T extends Record<string, unknown>>(
  map: Map<string, T>,
  key: string,
  item: T,
  idField: string,
): void => {
  const existing = map.get(key);
  if (existing === undefined) {
    map.set(key, item);
    return;
  }
  const { evidence_id: _a, evidence_ids: _b, ...leftSemantic } = existing;
  const { evidence_id: _c, evidence_ids: _d, ...rightSemantic } = item;
  void _a;
  void _b;
  void _c;
  void _d;
  if (
    digestCanonicalValue(leftSemantic, "Bundle item semantic check") !==
    digestCanonicalValue(rightSemantic, "Bundle item semantic check")
  ) {
    throw new TypeError(
      `Conflicting ${idField} definitions (${key}) across records in EvidenceBundle`,
    );
  }
  const mergedIds = [
    ...new Set([
      ...(typeof existing.evidence_id === "string"
        ? [existing.evidence_id]
        : []),
      ...(Array.isArray(existing.evidence_ids)
        ? (existing.evidence_ids as string[])
        : []),
      ...(typeof item.evidence_id === "string" ? [item.evidence_id] : []),
      ...(Array.isArray(item.evidence_ids)
        ? (item.evidence_ids as string[])
        : []),
    ]),
  ].sort(compareUnicodeCodePoints);
  if (mergedIds.length > 0) {
    map.set(key, {
      ...existing,
      ...(typeof existing.evidence_id === "string"
        ? { evidence_id: mergedIds[0] }
        : {}),
      evidence_ids: mergedIds,
    });
  }
};

const aggregateBundleRelationshipCoverage = (
  records: readonly Evidence[],
): AnalysisRunCoverage | null => {
  const coverages = records
    .map((r) => r.relationship_coverage)
    .filter((c): c is NonNullable<typeof c> => c !== null);
  if (coverages.length === 0) return null;
  const unknownCov = coverages.find((c) => c.status === "unknown");
  if (unknownCov !== undefined && unknownCov.status === "unknown") {
    return { status: "unknown", reason: unknownCov.reason };
  }
  const hasPartial =
    coverages.some((c) => c.status === "partial") ||
    coverages.length < records.length;
  const limitations = [
    ...new Set(
      coverages.flatMap((c) => (c.status === "partial" ? c.limitations : [])),
    ),
  ];
  return hasPartial
    ? { status: "partial", ...(limitations.length > 0 ? { limitations } : {}) }
    : { status: "complete" };
};

/**
 * Project an authenticated `EvidenceBundle` into a unified `AnalysisRunEnvelope`
 * for run-to-run comparison, retaining head revisions of residual unknowns.
 */
export const projectEvidenceBundleToAnalysisRun = (
  bundleInput: EvidenceBundle,
  runId: string,
): AnalysisRunEnvelope => {
  const bundle = parseEvidenceBundle(bundleInput);
  const sortedRecords = [...bundle.records].sort((a, b) =>
    compareUnicodeCodePoints(a.evidence_id, b.evidence_id),
  );
  const primaryRecord = sortedRecords[0];
  if (primaryRecord === undefined) {
    throw new TypeError(
      "Cannot project an empty EvidenceBundle with zero Evidence records into an AnalysisRunEnvelope",
    );
  }
  const nonNullSubjects = bundle.records
    .map((r) => r.subject)
    .filter((s): s is NonNullable<typeof s> => s !== null);
  const firstSubject = nonNullSubjects[0] ?? null;
  for (const subj of nonNullSubjects) {
    if (
      firstSubject !== null &&
      (subj.digest.sha256 !== firstSubject.digest.sha256 ||
        subj.format !== firstSubject.format ||
        subj.architecture !== firstSubject.architecture)
    ) {
      throw new TypeError(
        `Cannot project EvidenceBundle into a single AnalysisRunEnvelope when records target conflicting subject artifacts (${firstSubject.digest.sha256} vs ${subj.digest.sha256})`,
      );
    }
  }

  const proceduresByAddress = new Map<string, AnalysisRunProcedureRecord>();
  const findingsById = new Map<string, AnalysisRunFindingRecord>();
  const obligationsById = new Map<string, AnalysisRunObligationRecord>();

  for (const record of sortedRecords) {
    const extracted = extractStructuredItemsFromNormalizedResult(
      record.normalized_result,
      record.evidence_id,
    );
    for (const proc of extracted.procedures) {
      putConflictCheckedItem(
        proceduresByAddress,
        proc.address,
        proc,
        "procedure address",
      );
    }
    for (const finding of extracted.findings) {
      putConflictCheckedItem(
        findingsById,
        finding.finding_id,
        finding,
        "finding_id",
      );
    }
    for (const obligation of extracted.obligations) {
      putConflictCheckedItem(
        obligationsById,
        obligation.obligation_id,
        obligation,
        "obligation_id",
      );
    }
  }

  const headUnknownsById = new Map<string, AnalysisRunUnknownRecord>();
  for (const unknown of bundle.unknowns) {
    const prev = headUnknownsById.get(unknown.unknown_id);
    const prevRev = prev?.revision ?? 0;
    if (prev === undefined || unknown.revision > prevRev) {
      headUnknownsById.set(unknown.unknown_id, {
        unknown_id: unknown.unknown_id,
        question: unknown.question,
        status: unknown.status,
        disposition: unknown.resolution?.disposition ?? null,
        revision: unknown.revision,
        evidence_ids: [
          ...new Set([
            ...unknown.supporting_evidence_ids,
            ...unknown.contradicting_evidence_ids,
            ...unknown.mutation_evidence_ids,
            ...(unknown.resolution?.evidence_ids ?? []),
          ]),
        ].sort(compareUnicodeCodePoints),
      });
    }
  }

  return analysisRunEnvelopeSchema.parse({
    run_id: runId,
    evidence_id: primaryRecord.evidence_id,
    result_type: "evidence-bundle-run",
    operation: primaryRecord.operation,
    predicate_type: primaryRecord.predicate_type,
    subject:
      primaryRecord.subject === null
        ? null
        : {
            sha256: primaryRecord.subject.digest.sha256,
            format: primaryRecord.subject.format,
            architecture: primaryRecord.subject.architecture,
            local_path: primaryRecord.subject.local_path,
          },
    provider: {
      id: primaryRecord.provider.id,
      name: primaryRecord.provider.name,
      version: primaryRecord.provider.version,
    },
    relationship_coverage: aggregateBundleRelationshipCoverage(bundle.records),
    procedures: [...proceduresByAddress.values()],
    findings: [...findingsById.values()],
    obligations: [...obligationsById.values()],
    unknowns: [...headUnknownsById.values()],
    limitations: [
      ...new Set(sortedRecords.flatMap((record) => record.limitations)),
    ].sort(compareUnicodeCodePoints),
  });
};

/** Compare two authenticated `Evidence` records as analysis runs. */
export const compareEvidenceAnalysisRuns = (
  leftEvidence: Evidence,
  rightEvidence: Evidence,
  options?: CompareAnalysisRunsOptions,
): Result<AnalysisRunComparisonReport, AnalysisRunIncompatibility> =>
  compareAnalysisRuns(
    projectEvidenceToAnalysisRun(leftEvidence),
    projectEvidenceToAnalysisRun(rightEvidence),
    options,
  );

export { compareAnalysisRuns, compareCompatibleAnalysisRuns };
