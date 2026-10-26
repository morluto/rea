import { digestCanonicalValue } from "./canonicalDigest.js";
import type { Evidence } from "./evidence.js";
import { freezeJsonSnapshot } from "./immutableJson.js";
import { err, ok, type Result } from "./result.js";
import {
  describeSarifCategorySupport,
  isSupportedSarifFindingCategory,
  isValidHttpOrHttpsUri,
  mapReaSeverityToSarifLevel,
  REA_SARIF_DEFAULT_TOOL_NAME,
  REA_SARIF_EXPORT_VERSION,
  REA_SARIF_INFORMATION_URI,
  reaFindingSeveritySchema,
  SARIF_EXPORT_SCOPE_LIMITATION,
  SARIF_SCHEMA_URI,
  SARIF_VERSION,
  SarifExportError,
  SUPPORTED_SARIF_FINDING_CATEGORIES,
  type SarifResultLevel,
  type SupportedSarifFindingCategory,
  UNSUPPORTED_SARIF_ANALYSIS_CATEGORIES,
} from "./sarifExportCategories.js";
import {
  buildNormalizedFindingLocations,
  registerInputArtifact,
  trimOptionalString,
  validateOptionalDigest,
} from "./sarifExportLocations.js";
import {
  computeSarifRunDigest,
  evidenceIdSchema,
  type ExportFindingsToSarifInput,
  type SarifArtifact,
  type SarifExportFindingInput,
  type SarifLocation,
  type SarifLocationAvailability,
  type SarifLog,
  sarifLogSchema,
  type SarifMissingLocationField,
  type SarifReportingDescriptor,
  type SarifResult,
  type SarifResultProperties,
  type SarifToolDriver,
  type UnsignedSarifRun,
} from "./sarifExportSchemas.js";
import { compareUnicodeCodePoints } from "./unicodeCodePointOrder.js";

export * from "./sarifExportCategories.js";
export * from "./sarifExportLocations.js";
export * from "./sarifExportSchemas.js";

interface ExportAccumulatorContext {
  readonly knownEvidenceById: ReadonlyMap<string, Evidence>;
  readonly verifyAgainstRecords: boolean;
  readonly allEvidenceIds: Set<string>;
  readonly artifactsByUri: Map<string, SarifArtifact>;
}

const validateFindingEvidenceIds = (
  finding: SarifExportFindingInput,
  findingId: string,
  category: SupportedSarifFindingCategory,
  ctx: ExportAccumulatorContext,
): string[] => {
  if (
    !Array.isArray(finding.evidence_ids) ||
    finding.evidence_ids.length === 0
  ) {
    throw new SarifExportError(
      "missing_evidence_reference",
      `Finding ${JSON.stringify(findingId)} does not reference any REA evidence_id.`,
      { findingId, category },
    );
  }
  const validatedEvidenceIds = finding.evidence_ids.map((rawEvId) => {
    const parsedEvId = evidenceIdSchema.safeParse(rawEvId);
    if (!parsedEvId.success) {
      throw new SarifExportError(
        "missing_evidence_reference",
        `Finding ${JSON.stringify(findingId)} has an invalid evidence_id ${JSON.stringify(rawEvId)}.`,
        { findingId, category },
      );
    }
    if (
      ctx.verifyAgainstRecords &&
      !ctx.knownEvidenceById.has(parsedEvId.data)
    ) {
      throw new SarifExportError(
        "dangling_evidence_reference",
        `Finding ${JSON.stringify(findingId)} references missing evidence_id ${JSON.stringify(parsedEvId.data)}.`,
        { findingId, category },
      );
    }
    ctx.allEvidenceIds.add(parsedEvId.data);
    return parsedEvId.data;
  });
  return [...new Set(validatedEvidenceIds)].sort(compareUnicodeCodePoints);
};

interface PreparedFinding {
  readonly findingId: string;
  readonly ruleId: string;
  readonly category: SupportedSarifFindingCategory;
  readonly level: SarifResultLevel | undefined;
  readonly messageText: string;
  readonly locations: SarifLocation[];
  readonly properties: SarifResultProperties;
  readonly artifactSha256: string | null;
  readonly discoveredUris: Set<string>;
  readonly ruleName: string | undefined;
  readonly explicitShortDescription: string | undefined;
  readonly titleText: string | undefined;
  readonly ruleFullDescription: string | undefined;
  readonly ruleHelpUri: string | undefined;
}

const validateFindingHeader = (
  finding: SarifExportFindingInput,
  index: number,
) => {
  const findingId = finding.finding_id.trim();
  if (findingId.length === 0) {
    throw new SarifExportError(
      "invalid_finding_input",
      `Finding at index ${String(index)} has an empty finding_id.`,
    );
  }
  const support = describeSarifCategorySupport(finding.category);
  if (!isSupportedSarifFindingCategory(finding.category)) {
    throw new SarifExportError(
      "unsupported_finding_category",
      `Cannot export finding ${JSON.stringify(findingId)} with category ${JSON.stringify(finding.category)}: ${support.explanation}`,
      { findingId, category: finding.category },
    );
  }
  const category = finding.category;
  const ruleId = finding.rule_id.trim();
  if (ruleId.length === 0) {
    throw new SarifExportError(
      "invalid_rule_id",
      `Finding ${JSON.stringify(findingId)} has an empty rule_id.`,
      { findingId, category },
    );
  }
  const messageText = finding.message.trim();
  if (messageText.length === 0) {
    throw new SarifExportError(
      "invalid_finding_input",
      `Finding ${JSON.stringify(findingId)} has an empty message.`,
      { findingId, category },
    );
  }
  return { findingId, category, ruleId, messageText };
};

const buildResultProperties = (
  finding: SarifExportFindingInput,
  header: {
    readonly findingId: string;
    readonly category: SupportedSarifFindingCategory;
  },
  resolved: {
    readonly dedupedEvidenceIds: string[];
    readonly artifactSha256: string | null;
    readonly firstEvidence: Evidence | undefined;
    readonly mappedLevel: SarifResultLevel | undefined;
    readonly locationAvailability: SarifLocationAvailability;
    readonly missingLocationFields: SarifMissingLocationField[];
  },
): SarifResultProperties => {
  const parsedSev =
    finding.severity === null || finding.severity === undefined
      ? null
      : reaFindingSeveritySchema.parse(finding.severity);
  const defaultStatus =
    resolved.firstEvidence?.confidence === "observed"
      ? "observed"
      : resolved.firstEvidence !== undefined
        ? "inferred"
        : null;

  return {
    rea_finding_id: header.findingId,
    rea_category: header.category,
    rea_evidence_ids: resolved.dedupedEvidenceIds,
    rea_confidence:
      finding.confidence ?? resolved.firstEvidence?.confidence ?? null,
    rea_authority:
      finding.authority ?? resolved.firstEvidence?.authority ?? null,
    rea_status: finding.status ?? defaultStatus,
    rea_artifact_sha256: resolved.artifactSha256,
    rea_operation:
      trimOptionalString(finding.operation) ??
      resolved.firstEvidence?.operation ??
      null,
    rea_predicate_type:
      trimOptionalString(finding.predicate_type) ??
      resolved.firstEvidence?.predicate_type ??
      null,
    rea_severity: parsedSev,
    rea_severity_available: resolved.mappedLevel !== undefined,
    location_availability: resolved.locationAvailability,
    missing_location_fields: resolved.missingLocationFields,
    ...(finding.attributes === undefined
      ? {}
      : { rea_attributes: finding.attributes }),
  };
};

const prepareSingleFinding = (
  finding: SarifExportFindingInput,
  index: number,
  ctx: ExportAccumulatorContext,
): PreparedFinding => {
  const header = validateFindingHeader(finding, index);
  const mappedLevel = mapReaSeverityToSarifLevel(
    finding.severity,
    header.findingId,
  );
  const dedupedEvidenceIds = validateFindingEvidenceIds(
    finding,
    header.findingId,
    header.category,
    ctx,
  );
  const linkedRecords = dedupedEvidenceIds
    .map((id) => ctx.knownEvidenceById.get(id))
    .filter((rec): rec is Evidence => rec !== undefined);
  const firstEvidence =
    linkedRecords.length === 1 ? linkedRecords[0] : undefined;
  const locResult = buildNormalizedFindingLocations(
    finding.locations,
    finding.artifact_uri,
    header.findingId,
  );
  const explicitSha = validateOptionalDigest(
    finding.artifact_sha256,
    "invalid_artifact_uri",
    `finding ${JSON.stringify(header.findingId)} artifact_sha256`,
    header.findingId,
  );
  const linkedShas = [
    ...new Set(
      linkedRecords
        .map((rec) => rec.subject?.digest.sha256)
        .filter((sha): sha is string => sha !== undefined),
    ),
  ];
  if (
    explicitSha !== undefined &&
    linkedShas.length > 0 &&
    !linkedShas.includes(explicitSha)
  ) {
    throw new SarifExportError(
      "invalid_artifact_uri",
      `Finding ${JSON.stringify(header.findingId)} specifies artifact_sha256 (${explicitSha}) that does not match any linked Evidence record subject SHA-256.`,
      { findingId: header.findingId, category: header.category },
    );
  }
  const artifactSha256 =
    explicitSha ?? (linkedShas.length === 1 ? (linkedShas[0] ?? null) : null);

  return {
    ...header,
    level: mappedLevel,
    locations: locResult.locations,
    properties: buildResultProperties(finding, header, {
      dedupedEvidenceIds,
      artifactSha256,
      firstEvidence,
      mappedLevel,
      locationAvailability: locResult.availability,
      missingLocationFields: locResult.missingFields,
    }),
    artifactSha256,
    discoveredUris: locResult.discoveredUris,
    ruleName: trimOptionalString(finding.rule_name),
    explicitShortDescription: trimOptionalString(
      finding.rule_short_description,
    ),
    titleText: trimOptionalString(finding.title),
    ruleFullDescription: trimOptionalString(finding.rule_full_description),
    ruleHelpUri: trimOptionalString(finding.rule_help_uri),
  };
};

const LEVEL_RANK: Readonly<Record<SarifResultLevel, number>> = {
  none: 0,
  note: 1,
  warning: 2,
  error: 3,
};

interface RuleAccumulator {
  readonly id: string;
  readonly category: SupportedSarifFindingCategory;
  name: string | undefined;
  explicitShortDescription: string | undefined;
  fallbackTitle: string | undefined;
  fallbackTitleAmbiguous: boolean;
  fullDescription: string | undefined;
  helpUri: string | undefined;
  defaultLevel: SarifResultLevel | undefined;
}

const mergeRuleField = (
  existing: string | undefined,
  incoming: string | undefined,
  field: string,
  pf: PreparedFinding,
): string | undefined => {
  if (
    existing !== undefined &&
    incoming !== undefined &&
    existing !== incoming
  ) {
    throw new SarifExportError(
      "invalid_rule_id",
      `Finding ${JSON.stringify(pf.findingId)} specifies conflicting ${field} for rule_id ${JSON.stringify(pf.ruleId)}.`,
      { findingId: pf.findingId, category: pf.category },
    );
  }
  return existing ?? incoming;
};

const accumulateRuleFromFinding = (
  rulesById: Map<string, RuleAccumulator>,
  pf: PreparedFinding,
): void => {
  if (pf.ruleHelpUri !== undefined && !isValidHttpOrHttpsUri(pf.ruleHelpUri)) {
    throw new SarifExportError(
      "invalid_finding_input",
      `Finding ${JSON.stringify(pf.findingId)} has invalid rule_help_uri ${JSON.stringify(pf.ruleHelpUri)}.`,
      { findingId: pf.findingId, category: pf.category },
    );
  }
  const existing = rulesById.get(pf.ruleId);
  if (existing === undefined) {
    rulesById.set(pf.ruleId, {
      id: pf.ruleId,
      category: pf.category,
      name: pf.ruleName,
      explicitShortDescription: pf.explicitShortDescription,
      fallbackTitle: pf.titleText,
      fallbackTitleAmbiguous: false,
      fullDescription: pf.ruleFullDescription,
      helpUri: pf.ruleHelpUri,
      defaultLevel: pf.level,
    });
    return;
  }
  if (existing.category !== pf.category) {
    throw new SarifExportError(
      "invalid_rule_id",
      `Finding ${JSON.stringify(pf.findingId)} specifies conflicting category ${JSON.stringify(pf.category)} for rule_id ${JSON.stringify(pf.ruleId)}.`,
      { findingId: pf.findingId, category: pf.category },
    );
  }
  existing.name = mergeRuleField(existing.name, pf.ruleName, "rule_name", pf);
  existing.explicitShortDescription = mergeRuleField(
    existing.explicitShortDescription,
    pf.explicitShortDescription,
    "rule_short_description",
    pf,
  );
  if (pf.titleText !== undefined && !existing.fallbackTitleAmbiguous) {
    if (existing.fallbackTitle === undefined) {
      existing.fallbackTitle = pf.titleText;
    } else if (existing.fallbackTitle !== pf.titleText) {
      existing.fallbackTitle = undefined;
      existing.fallbackTitleAmbiguous = true;
    }
  }
  existing.fullDescription = mergeRuleField(
    existing.fullDescription,
    pf.ruleFullDescription,
    "rule_full_description",
    pf,
  );
  existing.helpUri = mergeRuleField(
    existing.helpUri,
    pf.ruleHelpUri,
    "rule_help_uri",
    pf,
  );
  if (
    pf.level !== undefined &&
    (existing.defaultLevel === undefined ||
      LEVEL_RANK[pf.level] > LEVEL_RANK[existing.defaultLevel])
  ) {
    existing.defaultLevel = pf.level;
  }
};

const finalizeRuleDescriptor = (
  acc: RuleAccumulator,
): SarifReportingDescriptor => ({
  id: acc.id,
  ...(acc.name === undefined ? {} : { name: acc.name }),
  shortDescription: {
    text:
      acc.explicitShortDescription ??
      acc.fallbackTitle ??
      `REA ${acc.category} finding (${acc.id})`,
  },
  ...(acc.fullDescription === undefined
    ? {}
    : { fullDescription: { text: acc.fullDescription } }),
  ...(acc.helpUri === undefined ? {} : { helpUri: acc.helpUri }),
  ...(acc.defaultLevel === undefined
    ? {}
    : { defaultConfiguration: { level: acc.defaultLevel } }),
  properties: {
    rea_category: acc.category,
    tags: ["rea", acc.category],
  },
});

const registerDiscoveredArtifactFromFinding = (
  artifactsByUri: Map<string, SarifArtifact>,
  pf: PreparedFinding,
): void => {
  const canBindHash =
    pf.artifactSha256 !== null && pf.discoveredUris.size === 1;
  for (const uri of pf.discoveredUris) {
    const existing = artifactsByUri.get(uri);
    if (existing === undefined) {
      artifactsByUri.set(uri, {
        location: { uri },
        ...(canBindHash && pf.artifactSha256 !== null
          ? { hashes: { "sha-256": pf.artifactSha256 } }
          : {}),
      });
      continue;
    }
    if (!canBindHash || pf.artifactSha256 === null) continue;
    const existingHash = existing.hashes?.["sha-256"];
    if (existingHash !== undefined && existingHash !== pf.artifactSha256) {
      throw new SarifExportError(
        "invalid_artifact_uri",
        `Finding ${JSON.stringify(pf.findingId)} specifies conflicting artifact_sha256 for URI ${JSON.stringify(uri)}.`,
        { findingId: pf.findingId, category: pf.category },
      );
    }
    if (existingHash === undefined) {
      artifactsByUri.set(uri, {
        ...existing,
        hashes: { "sha-256": pf.artifactSha256 },
      });
    }
  }
};

const buildToolDriver = (
  input: ExportFindingsToSarifInput,
  sortedRules: readonly SarifReportingDescriptor[],
): SarifToolDriver => {
  const toolVersion = trimOptionalString(input.tool?.version);
  return {
    name: trimOptionalString(input.tool?.name) ?? REA_SARIF_DEFAULT_TOOL_NAME,
    ...(toolVersion === undefined ? {} : { version: toolVersion }),
    informationUri:
      trimOptionalString(input.tool?.informationUri) ??
      REA_SARIF_INFORMATION_URI,
    rules: [...sortedRules],
  };
};

const buildSarifResultsList = (
  sortedFindings: readonly PreparedFinding[],
  ruleIndexById: ReadonlyMap<string, number>,
): SarifResult[] =>
  sortedFindings.map((pf) => ({
    ruleId: pf.ruleId,
    ruleIndex: ruleIndexById.get(pf.ruleId) ?? 0,
    ...(pf.level === undefined ? {} : { level: pf.level }),
    message: { text: pf.messageText },
    locations: pf.locations,
    partialFingerprints: {
      reaFindingDigest: digestCanonicalValue(
        {
          findingId: pf.findingId,
          ruleId: pf.ruleId,
          category: pf.category,
          level: pf.level ?? null,
          evidenceIds: pf.properties.rea_evidence_ids,
          message: pf.messageText,
          locations: pf.locations,
          properties: pf.properties,
        },
        "SARIF result fingerprint",
      ),
    },
    properties: pf.properties,
  }));

const buildUnsignedSarifRun = (
  input: ExportFindingsToSarifInput,
  ctx: ExportAccumulatorContext,
  preparedFindings: readonly PreparedFinding[],
): UnsignedSarifRun => {
  const profileDigest =
    validateOptionalDigest(
      input.analysis_profile_digest,
      "invalid_finding_input",
      "analysis_profile_digest",
    ) ?? null;

  const sortedFindings = [...preparedFindings].sort((a, b) => {
    const byRule = compareUnicodeCodePoints(a.ruleId, b.ruleId);
    return byRule !== 0
      ? byRule
      : compareUnicodeCodePoints(a.findingId, b.findingId);
  });

  const ruleAccumulators = new Map<string, RuleAccumulator>();
  for (const pf of sortedFindings) {
    accumulateRuleFromFinding(ruleAccumulators, pf);
    registerDiscoveredArtifactFromFinding(ctx.artifactsByUri, pf);
  }

  const sortedRules = [...ruleAccumulators.values()]
    .map(finalizeRuleDescriptor)
    .sort((a, b) => compareUnicodeCodePoints(a.id, b.id));
  const ruleIndexById = new Map(sortedRules.map((rule, idx) => [rule.id, idx]));
  const sortedArtifacts = [...ctx.artifactsByUri.values()].sort((a, b) =>
    compareUnicodeCodePoints(a.location.uri, b.location.uri),
  );
  const customLimitations = [
    ...new Set(
      (input.limitations ?? [])
        .map((item) => item.trim())
        .filter(
          (item) => item.length > 0 && item !== SARIF_EXPORT_SCOPE_LIMITATION,
        ),
    ),
  ].sort(compareUnicodeCodePoints);

  const sourceEvidenceIds = new Set<string>(ctx.allEvidenceIds);
  for (const rec of input.evidence_records ?? []) {
    sourceEvidenceIds.add(rec.evidence_id);
  }

  return {
    tool: { driver: buildToolDriver(input, sortedRules) },
    invocations: [
      {
        executionSuccessful: true,
        properties: {
          rea_provider_id: input.provider?.id ?? null,
          rea_provider_name: input.provider?.name ?? null,
          rea_provider_version: input.provider?.version ?? null,
          rea_analysis_profile_digest: profileDigest,
        },
      },
    ],
    artifacts: sortedArtifacts,
    results: buildSarifResultsList(sortedFindings, ruleIndexById),
    properties: {
      rea_export_version: REA_SARIF_EXPORT_VERSION,
      rea_supported_finding_categories: [...SUPPORTED_SARIF_FINDING_CATEGORIES],
      rea_unsupported_analysis_categories: [
        ...UNSUPPORTED_SARIF_ANALYSIS_CATEGORIES,
      ],
      rea_source_evidence_ids: [...sourceEvidenceIds].sort(
        compareUnicodeCodePoints,
      ),
      rea_provider_id: input.provider?.id ?? null,
      rea_analysis_profile_digest: profileDigest,
      rea_limitations: [SARIF_EXPORT_SCOPE_LIMITATION, ...customLimitations],
    },
  };
};

export const exportFindingsToSarif = (
  input: ExportFindingsToSarifInput,
): SarifLog => {
  const knownEvidenceById = new Map(
    (input.evidence_records ?? []).map((rec) => [rec.evidence_id, rec]),
  );
  const ctx: ExportAccumulatorContext = {
    knownEvidenceById,
    verifyAgainstRecords: input.evidence_records !== undefined,
    allEvidenceIds: new Set<string>(),
    artifactsByUri: new Map<string, SarifArtifact>(),
  };

  for (const rawArtifact of input.artifacts ?? []) {
    registerInputArtifact(ctx.artifactsByUri, rawArtifact);
  }

  const seenFindingIds = new Set<string>();
  const preparedFindings = input.findings.map((finding, index) => {
    const prepared = prepareSingleFinding(finding, index, ctx);
    if (seenFindingIds.has(prepared.findingId)) {
      throw new SarifExportError(
        "invalid_finding_input",
        `Duplicate finding_id ${JSON.stringify(prepared.findingId)} encountered during SARIF export.`,
        { findingId: prepared.findingId, category: prepared.category },
      );
    }
    seenFindingIds.add(prepared.findingId);
    return prepared;
  });

  const unsignedRun = buildUnsignedSarifRun(input, ctx, preparedFindings);
  const runDigest = computeSarifRunDigest(unsignedRun);
  return parseSarifLog({
    $schema: SARIF_SCHEMA_URI,
    version: SARIF_VERSION,
    runs: [
      {
        ...unsignedRun,
        properties: {
          ...unsignedRun.properties,
          rea_sarif_digest: runDigest,
        },
      },
    ],
  });
};

export const tryExportFindingsToSarif = (
  input: ExportFindingsToSarifInput,
): Result<SarifLog, SarifExportError> => {
  try {
    return ok(exportFindingsToSarif(input));
  } catch (error) {
    if (error instanceof SarifExportError) return err(error);
    return err(
      new SarifExportError(
        "sarif_integrity_failed",
        error instanceof Error ? error.message : String(error),
        { cause: error },
      ),
    );
  }
};

export const parseSarifLog = (raw: unknown): SarifLog => {
  const parsed = sarifLogSchema.safeParse(raw);
  if (!parsed.success) {
    throw new SarifExportError(
      "sarif_integrity_failed",
      `Invalid SARIF 2.1.0 document: ${parsed.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ")}`,
    );
  }
  return freezeJsonSnapshot(parsed.data);
};

export const serializeSarifLog = (log: SarifLog): string =>
  `${JSON.stringify(parseSarifLog(log), null, 2)}\n`;
