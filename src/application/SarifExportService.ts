import { rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { parseEvidence, type Evidence } from "../domain/evidence.js";
import {
  parseEvidenceBundle,
  type EvidenceBundle,
} from "../domain/evidenceBundle.js";
import { jsonObjectSchema } from "../domain/jsonValue.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  convertEvidenceLocationToSarifLocationInput,
  describeSarifCategorySupport,
  exportFindingsToSarif,
  normalizeSarifArtifactUri,
  SarifExportError,
  serializeSarifLog,
  type SarifExportArtifactInput,
  type SarifExportFindingInput,
  type SarifExportFindingLocationInput,
  type SarifLog,
} from "../domain/sarifExport.js";

const HEX_ADDRESS_PATTERN = /^0x[0-9a-fA-F]+(?:\.\.0x[0-9a-fA-F]+)?$/u;

const pickOptionalField = <K extends string, V>(
  record: Record<string, unknown>,
  key: K,
): Partial<Record<K, V>> =>
  record[key] !== undefined
    ? ({ [key]: record[key] as V } as Partial<Record<K, V>>)
    : {};

const parseStringLocationEntry = (
  rawLoc: string,
  findingId: string,
  defaultArtifactUri?: string | null,
): SarifExportFindingLocationInput => {
  const trimmed = rawLoc.trim();
  if (trimmed.length === 0) {
    throw new SarifExportError(
      "invalid_location_metadata",
      `Finding ${JSON.stringify(findingId)} contains an empty location string.`,
      { findingId },
    );
  }
  if (HEX_ADDRESS_PATTERN.test(trimmed)) {
    return {
      ...(defaultArtifactUri ? { uri: defaultArtifactUri } : {}),
      address: trimmed,
    };
  }
  return { uri: trimmed };
};

const parseStructuredLocationEntry = (
  rawLoc: unknown,
  findingId: string,
  defaultArtifactUri?: string | null,
): SarifExportFindingLocationInput => {
  if (typeof rawLoc === "string") {
    return parseStringLocationEntry(rawLoc, findingId, defaultArtifactUri);
  }
  if (typeof rawLoc !== "object" || rawLoc === null || Array.isArray(rawLoc)) {
    throw new SarifExportError(
      "invalid_location_metadata",
      `Finding ${JSON.stringify(findingId)} contains a non-object location entry.`,
      { findingId },
    );
  }
  const record = rawLoc as Record<string, unknown>;
  const uriPart: Partial<Record<"uri", string | null>> =
    record.uri !== undefined
      ? { uri: record.uri as string | null }
      : defaultArtifactUri
        ? { uri: defaultArtifactUri }
        : {};
  return {
    ...uriPart,
    ...pickOptionalField<"uriBaseId", string | null>(record, "uriBaseId"),
    ...pickOptionalField<"startLine", number | null>(record, "startLine"),
    ...pickOptionalField<"startColumn", number | null>(record, "startColumn"),
    ...pickOptionalField<"endLine", number | null>(record, "endLine"),
    ...pickOptionalField<"endColumn", number | null>(record, "endColumn"),
    ...pickOptionalField<"byteOffset", number | null>(record, "byteOffset"),
    ...pickOptionalField<"byteLength", number | null>(record, "byteLength"),
    ...pickOptionalField<"snippetText", string | null>(record, "snippetText"),
    ...pickOptionalField<"address", string | null>(record, "address"),
    ...pickOptionalField<"addressLengthBytes", number | null>(
      record,
      "addressLengthBytes",
    ),
    ...pickOptionalField<"logicalName", string | null>(record, "logicalName"),
    ...pickOptionalField<"logicalKind", string | null>(record, "logicalKind"),
  };
};

const resolveSubjectArtifactUri = (
  evidence: Evidence,
  overrideUri?: string | null,
): string | null => {
  if (typeof overrideUri === "string" && overrideUri.trim().length > 0) {
    const normalized = normalizeSarifArtifactUri(overrideUri);
    if (!normalized.ok) {
      throw new SarifExportError(
        "invalid_artifact_uri",
        `Invalid defaultArtifactUri ${JSON.stringify(overrideUri)}: ${normalized.error}`,
      );
    }
    return normalized.value;
  }
  if (evidence.subject !== null) {
    const normalized = normalizeSarifArtifactUri(evidence.subject.name);
    if (normalized.ok) return normalized.value;
  }
  return null;
};

const pickNonEmptyText = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;

const resolveFindingMessageText = (item: Record<string, unknown>): string =>
  pickNonEmptyText(item.message) ??
  pickNonEmptyText(item.summary) ??
  pickNonEmptyText(item.title) ??
  "";

const resolveFindingLocations = (
  item: Record<string, unknown>,
  findingId: string,
  subjectArtifactUri: string | null,
  fallbackLocations: readonly SarifExportFindingLocationInput[],
): SarifExportFindingLocationInput[] => {
  if (Array.isArray(item.locations)) {
    return item.locations.map((loc) =>
      parseStructuredLocationEntry(loc, findingId, subjectArtifactUri),
    );
  }
  if (item.locations === null) {
    return [];
  }
  return [...fallbackLocations];
};

const resolveFindingConfidence = (
  rawConfidence: unknown,
  defaultConfidence: Evidence["confidence"],
): Evidence["confidence"] =>
  rawConfidence === "observed" ||
  rawConfidence === "derived" ||
  rawConfidence === "inferred"
    ? rawConfidence
    : defaultConfidence;

const resolveFindingStatus = (
  rawStatus: unknown,
  defaultConfidence: Evidence["confidence"],
): "observed" | "verified" | "open" | "inferred" =>
  rawStatus === "observed" ||
  rawStatus === "verified" ||
  rawStatus === "open" ||
  rawStatus === "inferred"
    ? rawStatus
    : defaultConfidence === "observed"
      ? "observed"
      : "inferred";

interface EvidenceExtractionContext {
  readonly evidence: Evidence;
  readonly subjectArtifactUri: string | null;
  readonly fallbackLocations: readonly SarifExportFindingLocationInput[];
}

const resolveExtraEvidenceIds = (item: Record<string, unknown>): string[] => {
  if (Array.isArray(item.evidence_ids)) {
    return item.evidence_ids.filter(
      (id): id is string => typeof id === "string",
    );
  }
  return typeof item.evidence_id === "string" ? [item.evidence_id] : [];
};

const resolveRawRuleId = (
  item: Record<string, unknown>,
  category: string,
): string => {
  if (item.rule_id === undefined || item.rule_id === null) {
    return `rea/${category}`;
  }
  return typeof item.rule_id === "string" ? item.rule_id : "";
};

const resolveRawSeverity = (rawSeverity: unknown): string | null => {
  if (rawSeverity === undefined || rawSeverity === null) return null;
  return typeof rawSeverity === "string" ? rawSeverity : String(rawSeverity);
};

const resolveOptionalItemFields = (
  item: Record<string, unknown>,
): Pick<SarifExportFindingInput, "rule_name" | "title" | "attributes"> => ({
  ...(typeof item.rule_name === "string" ? { rule_name: item.rule_name } : {}),
  ...(typeof item.title === "string" ? { title: item.title } : {}),
  ...(typeof item.attributes === "object" &&
  item.attributes !== null &&
  !Array.isArray(item.attributes)
    ? { attributes: jsonObjectSchema.parse(item.attributes) }
    : {}),
});

const extractSingleFindingItem = (
  rawEntry: unknown,
  index: number,
  ctx: EvidenceExtractionContext,
): SarifExportFindingInput => {
  const { evidence, subjectArtifactUri, fallbackLocations } = ctx;
  if (
    typeof rawEntry !== "object" ||
    rawEntry === null ||
    Array.isArray(rawEntry)
  ) {
    throw new SarifExportError(
      "invalid_finding_input",
      `Evidence ${evidence.evidence_id} contains a non-object finding at index ${String(index)}.`,
    );
  }
  const item = rawEntry as Record<string, unknown>;
  const findingId = pickNonEmptyText(item.finding_id) ?? "";
  if (findingId.length === 0) {
    throw new SarifExportError(
      "invalid_finding_input",
      `Evidence ${evidence.evidence_id} finding at index ${String(index)} is missing a non-empty finding_id.`,
    );
  }
  const category = pickNonEmptyText(item.category) ?? "";
  if (category.length === 0) {
    throw new SarifExportError(
      "invalid_finding_input",
      `Finding ${JSON.stringify(findingId)} in Evidence ${evidence.evidence_id} is missing a non-empty category.`,
      { findingId },
    );
  }
  const parsedLocations = resolveFindingLocations(
    item,
    findingId,
    subjectArtifactUri,
    fallbackLocations,
  );
  return {
    finding_id: findingId,
    rule_id: resolveRawRuleId(item, category),
    ...resolveOptionalItemFields(item),
    category,
    severity: resolveRawSeverity(item.severity),
    confidence: resolveFindingConfidence(item.confidence, evidence.confidence),
    authority: evidence.authority,
    status: resolveFindingStatus(item.status, evidence.confidence),
    message: resolveFindingMessageText(item),
    locations: parsedLocations,
    evidence_ids: [
      evidence.evidence_id,
      ...evidence.evidence_links,
      ...resolveExtraEvidenceIds(item),
    ],
    artifact_sha256: evidence.subject?.digest.sha256 ?? null,
    artifact_uri: parsedLocations.length > 0 ? subjectArtifactUri : null,
    operation: evidence.operation,
    predicate_type: evidence.predicate_type,
  };
};

/**
 * Extract structured `SarifExportFindingInput` records from an authenticated
 * REA `Evidence` observation without fabricating severity or location metadata.
 */
export const extractStructuredFindingsFromEvidence = (
  evidenceInput: Evidence,
  options?: {
    readonly defaultArtifactUri?: string | null;
  },
): readonly SarifExportFindingInput[] => {
  const evidence = parseEvidence(evidenceInput);
  const subjectArtifactUri = resolveSubjectArtifactUri(
    evidence,
    options?.defaultArtifactUri,
  );

  if (
    typeof evidence.normalized_result !== "object" ||
    evidence.normalized_result === null ||
    Array.isArray(evidence.normalized_result)
  ) {
    return [];
  }

  const record = evidence.normalized_result as Record<string, unknown>;
  if (typeof record.analysis_category === "string") {
    const support = describeSarifCategorySupport(record.analysis_category);
    if (!support.supported) {
      throw new SarifExportError(
        "unsupported_finding_category",
        `Cannot export Evidence ${evidence.evidence_id} with analysis_category ${JSON.stringify(record.analysis_category)}: ${support.explanation}`,
        { category: record.analysis_category },
      );
    }
  }

  if (record.findings === undefined) return [];
  if (!Array.isArray(record.findings)) {
    throw new SarifExportError(
      "invalid_finding_input",
      `Evidence ${evidence.evidence_id} has a non-array normalized_result.findings field.`,
    );
  }

  const fallbackLocations: SarifExportFindingLocationInput[] =
    evidence.locations.map((loc) =>
      convertEvidenceLocationToSarifLocationInput(loc, subjectArtifactUri),
    );

  return record.findings.map((rawEntry, index) =>
    extractSingleFindingItem(rawEntry, index, {
      evidence,
      subjectArtifactUri,
      fallbackLocations,
    }),
  );
};

export interface ExportEvidenceToSarifOptions {
  readonly defaultArtifactUri?: string | null;
  readonly tool?: {
    readonly name?: string;
    readonly version?: string | null;
    readonly informationUri?: string;
  };
  readonly additionalFindings?: readonly SarifExportFindingInput[];
  readonly limitations?: readonly string[];
}

/**
 * Export an authenticated REA `Evidence` record's supported findings as SARIF 2.1.0.
 */
export const exportEvidenceToSarif = (
  evidenceInput: Evidence,
  options?: ExportEvidenceToSarifOptions,
): SarifLog => {
  const evidence = parseEvidence(evidenceInput);
  const extractedFindings = extractStructuredFindingsFromEvidence(evidence, {
    defaultArtifactUri: options?.defaultArtifactUri ?? null,
  });
  const subjectArtifactUri = resolveSubjectArtifactUri(
    evidence,
    options?.defaultArtifactUri,
  );

  const artifacts: SarifExportArtifactInput[] =
    evidence.subject !== null && subjectArtifactUri !== null
      ? [
          {
            uri: subjectArtifactUri,
            sha256: evidence.subject.digest.sha256,
            format: evidence.subject.format,
            architecture: evidence.subject.architecture,
          },
        ]
      : [];

  return exportFindingsToSarif({
    ...(options?.tool === undefined ? {} : { tool: options.tool }),
    provider: {
      id: evidence.provider.id,
      name: evidence.provider.name,
      version: evidence.provider.version,
    },
    artifacts,
    findings: [...extractedFindings, ...(options?.additionalFindings ?? [])],
    evidence_records: [evidence],
    limitations: [...evidence.limitations, ...(options?.limitations ?? [])],
  });
};

/**
 * Non-throwing `Result` wrapper around `exportEvidenceToSarif`.
 */
export const tryExportEvidenceToSarif = (
  evidenceInput: Evidence,
  options?: ExportEvidenceToSarifOptions,
): Result<SarifLog, SarifExportError> => {
  try {
    return ok(exportEvidenceToSarif(evidenceInput, options));
  } catch (cause: unknown) {
    if (cause instanceof SarifExportError) return err(cause);
    const message =
      cause instanceof Error
        ? cause.message
        : "Failed to export Evidence to SARIF 2.1.0";
    return err(
      new SarifExportError("invalid_finding_input", message, { cause }),
    );
  }
};

export interface ExportEvidenceBundleToSarifOptions {
  readonly defaultArtifactUriBySha256?: Readonly<Record<string, string>>;
  readonly tool?: {
    readonly name?: string;
    readonly version?: string | null;
    readonly informationUri?: string;
  };
  readonly additionalFindings?: readonly SarifExportFindingInput[];
  readonly limitations?: readonly string[];
}

/**
 * Export supported findings across an authenticated REA `EvidenceBundle` as a
 * single SARIF 2.1.0 log while preserving all Evidence references and recording
 * residual-unknown limitations without fabricating findings.
 */
export const exportEvidenceBundleToSarif = (
  bundleInput: EvidenceBundle,
  options?: ExportEvidenceBundleToSarifOptions,
): SarifLog => {
  const bundle = parseEvidenceBundle(bundleInput);
  const findings: SarifExportFindingInput[] = [];
  const artifacts: SarifExportArtifactInput[] = [];

  for (const record of bundle.records) {
    const overrideUri =
      record.subject !== null
        ? (options?.defaultArtifactUriBySha256?.[
            record.subject.digest.sha256
          ] ?? null)
        : null;
    findings.push(
      ...extractStructuredFindingsFromEvidence(record, {
        defaultArtifactUri: overrideUri,
      }),
    );

    const subjectUri = resolveSubjectArtifactUri(record, overrideUri);
    if (record.subject !== null && subjectUri !== null) {
      artifacts.push({
        uri: subjectUri,
        sha256: record.subject.digest.sha256,
        format: record.subject.format,
        architecture: record.subject.architecture,
      });
    }
  }

  findings.push(...(options?.additionalFindings ?? []));

  const uniqueProviders = bundle.providers;
  const singleProvider =
    uniqueProviders.length === 1 && uniqueProviders[0] !== undefined
      ? {
          id: uniqueProviders[0].id,
          name: uniqueProviders[0].name,
          version: uniqueProviders[0].version,
        }
      : null;

  const bundleLimitations: string[] = [...(options?.limitations ?? [])];
  if (bundle.unknowns.length > 0) {
    bundleLimitations.push(
      `Bundle contains ${String(bundle.unknowns.length)} residual unknown record(s); residual unknowns represent open investigation questions and are intentionally omitted from SARIF findings.`,
    );
  }

  return exportFindingsToSarif({
    ...(options?.tool === undefined ? {} : { tool: options.tool }),
    provider: singleProvider,
    artifacts,
    findings,
    evidence_records: bundle.records,
    limitations: bundleLimitations,
  });
};

/**
 * Non-throwing `Result` wrapper around `exportEvidenceBundleToSarif`.
 */
export const tryExportEvidenceBundleToSarif = (
  bundleInput: EvidenceBundle,
  options?: ExportEvidenceBundleToSarifOptions,
): Result<SarifLog, SarifExportError> => {
  try {
    return ok(exportEvidenceBundleToSarif(bundleInput, options));
  } catch (cause: unknown) {
    if (cause instanceof SarifExportError) return err(cause);
    const message =
      cause instanceof Error
        ? cause.message
        : "Failed to export EvidenceBundle to SARIF 2.1.0";
    return err(
      new SarifExportError("invalid_finding_input", message, { cause }),
    );
  }
};

/**
 * Atomically write a validated SARIF 2.1.0 log to disk as canonical UTF-8 JSON.
 */
export const writeSarifLogFile = async (
  filePath: string,
  sarifLog: SarifLog,
): Promise<void> => {
  const targetPath = resolve(filePath);
  const parentDir = dirname(targetPath);
  const tempPath = join(
    parentDir,
    `.rea-sarif-export.tmp-${String(process.pid)}-${String(Date.now())}`,
  );
  const serialized = serializeSarifLog(sarifLog);
  try {
    await writeFile(tempPath, serialized, { encoding: "utf8", flag: "wx" });
    await rename(tempPath, targetPath);
  } catch (cause: unknown) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw cause;
  }
};
