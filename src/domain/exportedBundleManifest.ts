import canonicalize from "canonicalize";
import { z } from "zod";

import { digestSchema } from "./digests.js";
import { EvidenceIntegrityError } from "./evidenceErrors.js";
import {
  computeExportedBundleManifestDigest,
  EXPORTED_BUNDLE_MANIFEST_FILENAME,
  EXPORTED_BUNDLE_MANIFEST_SCOPE_LIMITATION,
  EXPORTED_BUNDLE_MANIFEST_VERSION,
  type exportedBundleArtifactProvenanceSchema,
  type ExportedBundleEntry,
  type ExportedBundleKind,
  type ExportedBundleManifest,
  exportedBundleManifestSchema,
  type exportedBundleProfileProvenanceSchema,
  type exportedBundleProviderProvenanceSchema,
  type ExportedBundleVerificationFinding,
  type ExportedBundleVerificationReport,
  exportedBundleVerificationReportSchema,
  foldBundlePathCase,
  normalizeExportedBundleRelativePath,
  type ObservedBundleFileSystemEntry,
  type UnsignedExportedBundleManifest,
} from "./exportedBundleManifestSchemas.js";
import { freezeJsonSnapshot } from "./immutableJson.js";
import { jsonValueSchema } from "./jsonValue.js";
import {
  compareUnicodeCodePoints,
  compositeKey,
} from "./unicodeCodePointOrder.js";

export * from "./exportedBundleManifestSchemas.js";

export interface CreateExportedBundleManifestInput {
  readonly bundle_kind: ExportedBundleKind;
  readonly entries: readonly {
    readonly relative_path: string;
    readonly sha256: string;
    readonly bytes: number;
    readonly role?: string | null;
  }[];
  readonly provenance?: {
    readonly artifact?: z.infer<typeof exportedBundleArtifactProvenanceSchema>;
    readonly provider?: z.infer<typeof exportedBundleProviderProvenanceSchema>;
    readonly analysis_profile?: z.infer<
      typeof exportedBundleProfileProvenanceSchema
    >;
    readonly source_evidence_ids?: readonly string[];
  };
  readonly limitations?: readonly string[];
}

/** Parse and authenticate an exported bundle manifest, failing closed on tampering. */
export const parseExportedBundleManifest = (
  input: unknown,
): ExportedBundleManifest => {
  try {
    return freezeJsonSnapshot(exportedBundleManifestSchema.parse(input));
  } catch (cause: unknown) {
    const message =
      cause instanceof z.ZodError
        ? cause.issues
            .map(
              (issue) =>
                `${issue.path.join(".") || "manifest"}: ${issue.message}`,
            )
            .join("; ")
        : cause instanceof Error
          ? cause.message
          : "Invalid exported bundle manifest";
    throw new EvidenceIntegrityError(
      `Exported bundle manifest validation failed: ${message}`,
      { cause },
    );
  }
};

/**
 * Create a canonical, versioned exported bundle manifest.
 * Any provenance section not supplied by the caller is explicitly recorded as
 * `{ available: false, reason }` rather than guessed.
 */
export const createExportedBundleManifest = (
  input: CreateExportedBundleManifestInput,
): ExportedBundleManifest => {
  const normalizedEntries = input.entries
    .map((entry) => {
      const normalizedPath = normalizeExportedBundleRelativePath(
        entry.relative_path,
      );
      if (!normalizedPath.ok) {
        throw new EvidenceIntegrityError(normalizedPath.error);
      }
      return {
        relative_path: normalizedPath.value,
        sha256: entry.sha256,
        bytes: entry.bytes,
        role: entry.role ?? null,
      };
    })
    .sort((left, right) =>
      compareUnicodeCodePoints(left.relative_path, right.relative_path),
    );

  const uniqueEvidenceIds = [
    ...new Set(input.provenance?.source_evidence_ids ?? []),
  ].sort(compareUnicodeCodePoints);

  const uniqueLimitations = [
    ...new Set([
      EXPORTED_BUNDLE_MANIFEST_SCOPE_LIMITATION,
      ...(input.limitations ?? []),
    ]),
  ].sort(compareUnicodeCodePoints);

  const unsigned: UnsignedExportedBundleManifest = {
    schema_version: EXPORTED_BUNDLE_MANIFEST_VERSION,
    bundle_kind: input.bundle_kind,
    provenance: {
      artifact: input.provenance?.artifact ?? {
        available: false,
        reason: "Artifact identity was not provided at bundle export time.",
      },
      provider: input.provenance?.provider ?? {
        available: false,
        reason: "Provider metadata was not provided at bundle export time.",
      },
      analysis_profile: input.provenance?.analysis_profile ?? {
        available: false,
        reason:
          "Analysis profile commitment was not provided at bundle export time.",
      },
      source_evidence_ids: uniqueEvidenceIds,
    },
    summary: {
      file_count: normalizedEntries.length,
      total_bytes: normalizedEntries.reduce(
        (sum, entry) => sum + entry.bytes,
        0,
      ),
    },
    entries: normalizedEntries,
    limitations: uniqueLimitations,
  };

  return parseExportedBundleManifest({
    ...unsigned,
    manifest_sha256: computeExportedBundleManifestDigest(unsigned),
  });
};

/** Encode a validated exported bundle manifest as byte-stable RFC 8785 canonical JSON. */
export const serializeExportedBundleManifest = (
  manifest: ExportedBundleManifest,
): string => {
  const validated = parseExportedBundleManifest(manifest);
  const encoded = canonicalize(jsonValueSchema.parse(validated));
  if (encoded === undefined) {
    throw new TypeError("Exported bundle manifest canonicalization failed");
  }
  return `${encoded}\n`;
};

const sortVerificationFindings = (
  findings: readonly ExportedBundleVerificationFinding[],
): ExportedBundleVerificationFinding[] =>
  [...findings].sort((left, right) =>
    compareUnicodeCodePoints(
      compositeKey([left.relative_path ?? "", left.kind, left.message]),
      compositeKey([right.relative_path ?? "", right.kind, right.message]),
    ),
  );

interface ScannedObservedEntries {
  readonly validObservedByPath: ReadonlyMap<
    string,
    { readonly sha256: string; readonly bytes: number }
  >;
  readonly findings: ExportedBundleVerificationFinding[];
  readonly observedRegularFileCount: number;
  readonly invalidEntriesCount: number;
}

const scanObservedEntries = (
  observedEntries: readonly ObservedBundleFileSystemEntry[],
  expectedByPath: ReadonlyMap<string, ExportedBundleEntry>,
): ScannedObservedEntries => {
  const findings: ExportedBundleVerificationFinding[] = [];
  const validObservedByPath = new Map<
    string,
    { readonly sha256: string; readonly bytes: number }
  >();
  const seenFoldedPaths = new Set<string>();
  let observedRegularFileCount = 0;
  let invalidEntriesCount = 0;

  for (const observed of observedEntries) {
    if (observed.relative_path === EXPORTED_BUNDLE_MANIFEST_FILENAME) continue;

    const normalizedPath = normalizeExportedBundleRelativePath(
      observed.relative_path,
    );
    if (!normalizedPath.ok) {
      invalidEntriesCount += 1;
      findings.push({
        kind: "invalid_entry_path",
        relative_path: observed.relative_path,
        expected_sha256: null,
        observed_sha256: null,
        expected_bytes: null,
        observed_bytes: null,
        message: normalizedPath.error,
      });
      continue;
    }

    const pathKey = normalizedPath.value;
    const foldedKey = foldBundlePathCase(pathKey);
    if (seenFoldedPaths.has(foldedKey)) {
      invalidEntriesCount += 1;
      findings.push({
        kind: "duplicate_observed_path",
        relative_path: pathKey,
        expected_sha256: null,
        observed_sha256: null,
        expected_bytes: null,
        observed_bytes: null,
        message: `Observed bundle entries contain duplicate or case-colliding relative path ${JSON.stringify(pathKey)}`,
      });
      continue;
    }
    seenFoldedPaths.add(foldedKey);

    const entryKind = observed.kind ?? "file";
    if (entryKind !== "file") {
      invalidEntriesCount += 1;
      findings.push({
        kind: "non_regular_entry",
        relative_path: pathKey,
        expected_sha256: expectedByPath.get(pathKey)?.sha256 ?? null,
        observed_sha256: null,
        expected_bytes: expectedByPath.get(pathKey)?.bytes ?? null,
        observed_bytes: null,
        message: `Bundle entry ${JSON.stringify(pathKey)} is a non-regular filesystem object (${entryKind}); symlinks and special files are rejected`,
      });
      continue;
    }

    const parsedDigest = digestSchema.safeParse(observed.sha256);
    const parsedBytes = z.int().min(0).safeParse(observed.bytes);
    if (!parsedDigest.success || !parsedBytes.success) {
      invalidEntriesCount += 1;
      findings.push({
        kind: "non_regular_entry",
        relative_path: pathKey,
        expected_sha256: expectedByPath.get(pathKey)?.sha256 ?? null,
        observed_sha256: null,
        expected_bytes: expectedByPath.get(pathKey)?.bytes ?? null,
        observed_bytes: null,
        message: `Observed regular file ${JSON.stringify(pathKey)} is missing a valid SHA-256 digest or non-negative byte size`,
      });
      continue;
    }

    observedRegularFileCount += 1;
    validObservedByPath.set(pathKey, {
      sha256: parsedDigest.data,
      bytes: parsedBytes.data,
    });
  }

  return {
    validObservedByPath,
    findings,
    observedRegularFileCount,
    invalidEntriesCount,
  };
};

const reconcileManifestAgainstObserved = (
  manifest: ExportedBundleManifest,
  expectedByPath: ReadonlyMap<string, ExportedBundleEntry>,
  scanned: ScannedObservedEntries,
): {
  readonly findings: ExportedBundleVerificationFinding[];
  readonly verifiedFilesCount: number;
  readonly missingFilesCount: number;
  readonly modifiedFilesCount: number;
  readonly unexpectedFilesCount: number;
} => {
  const findings = [...scanned.findings];
  let verifiedFilesCount = 0;
  let missingFilesCount = 0;
  let modifiedFilesCount = 0;
  let unexpectedFilesCount = 0;

  for (const expected of manifest.entries) {
    const observed = scanned.validObservedByPath.get(expected.relative_path);
    if (observed === undefined) {
      const hasInvalidFinding = findings.some(
        (finding) => finding.relative_path === expected.relative_path,
      );
      if (!hasInvalidFinding) {
        missingFilesCount += 1;
        findings.push({
          kind: "missing_file",
          relative_path: expected.relative_path,
          expected_sha256: expected.sha256,
          observed_sha256: null,
          expected_bytes: expected.bytes,
          observed_bytes: null,
          message: `Expected bundle file ${JSON.stringify(expected.relative_path)} is missing`,
        });
      }
      continue;
    }

    const sizeMatches = observed.bytes === expected.bytes;
    const digestMatches = observed.sha256 === expected.sha256;
    if (sizeMatches && digestMatches) {
      verifiedFilesCount += 1;
      continue;
    }

    modifiedFilesCount += 1;
    if (!sizeMatches) {
      findings.push({
        kind: "size_mismatch",
        relative_path: expected.relative_path,
        expected_sha256: expected.sha256,
        observed_sha256: observed.sha256,
        expected_bytes: expected.bytes,
        observed_bytes: observed.bytes,
        message: `Bundle file ${JSON.stringify(expected.relative_path)} byte size changed: expected ${String(expected.bytes)}, observed ${String(observed.bytes)}`,
      });
    }
    if (!digestMatches) {
      findings.push({
        kind: "digest_mismatch",
        relative_path: expected.relative_path,
        expected_sha256: expected.sha256,
        observed_sha256: observed.sha256,
        expected_bytes: expected.bytes,
        observed_bytes: observed.bytes,
        message: `Bundle file ${JSON.stringify(expected.relative_path)} SHA-256 digest changed: expected ${expected.sha256}, observed ${observed.sha256}`,
      });
    }
  }

  for (const [
    observedPath,
    observed,
  ] of scanned.validObservedByPath.entries()) {
    if (expectedByPath.has(observedPath)) continue;
    unexpectedFilesCount += 1;
    findings.push({
      kind: "unexpected_file",
      relative_path: observedPath,
      expected_sha256: null,
      observed_sha256: observed.sha256,
      expected_bytes: null,
      observed_bytes: observed.bytes,
      message: `Unexpected file ${JSON.stringify(observedPath)} is not listed in the bundle manifest`,
    });
  }

  return {
    findings: sortVerificationFindings(findings),
    verifiedFilesCount,
    missingFilesCount,
    modifiedFilesCount,
    unexpectedFilesCount,
  };
};

/**
 * Verify observed bundle files against an exported bundle manifest without
 * executing any bundled artifacts. Detects tampered manifests, invalid/traversal
 * paths, non-regular files/symlinks, missing files, modified files, and unexpected files.
 */
export const verifyExportedBundleManifest = (
  manifestInput: unknown,
  observedEntries: readonly ObservedBundleFileSystemEntry[],
): ExportedBundleVerificationReport => {
  const parsedManifest = exportedBundleManifestSchema.safeParse(manifestInput);
  if (!parsedManifest.success) {
    const preScanned = scanObservedEntries(observedEntries, new Map());
    const manifestFindings: ExportedBundleVerificationFinding[] =
      parsedManifest.error.issues.map((issue) => ({
        kind: issue.path.includes("relative_path")
          ? "invalid_entry_path"
          : "manifest_integrity_failed",
        relative_path: null,
        expected_sha256: null,
        observed_sha256: null,
        expected_bytes: null,
        observed_bytes: null,
        message: `${issue.path.join(".") || "manifest"}: ${issue.message}`,
      }));
    const sortedFindings = sortVerificationFindings([
      ...manifestFindings,
      ...preScanned.findings,
    ]);
    return freezeJsonSnapshot(
      exportedBundleVerificationReportSchema.parse({
        verified: false,
        status: "invalid_manifest",
        manifest_sha256: null,
        bundle_kind: null,
        summary: {
          expected_files: 0,
          observed_files: preScanned.observedRegularFileCount,
          verified_files: 0,
          missing_files: 0,
          modified_files: 0,
          unexpected_files: 0,
          invalid_entries: sortedFindings.length,
        },
        findings: sortedFindings,
        limitations: [EXPORTED_BUNDLE_MANIFEST_SCOPE_LIMITATION],
      }),
    );
  }

  const manifest = parsedManifest.data;
  const expectedByPath = new Map<string, ExportedBundleEntry>(
    manifest.entries.map((entry) => [entry.relative_path, entry]),
  );
  const scanned = scanObservedEntries(observedEntries, expectedByPath);
  const reconciled = reconcileManifestAgainstObserved(
    manifest,
    expectedByPath,
    scanned,
  );
  const verified = reconciled.findings.length === 0;

  return freezeJsonSnapshot(
    exportedBundleVerificationReportSchema.parse({
      verified,
      status: verified ? "verified" : "failed",
      manifest_sha256: manifest.manifest_sha256,
      bundle_kind: manifest.bundle_kind,
      summary: {
        expected_files: manifest.entries.length,
        observed_files: scanned.observedRegularFileCount,
        verified_files: reconciled.verifiedFilesCount,
        missing_files: reconciled.missingFilesCount,
        modified_files: reconciled.modifiedFilesCount,
        unexpected_files: reconciled.unexpectedFilesCount,
        invalid_entries: scanned.invalidEntriesCount,
      },
      findings: reconciled.findings,
      limitations: manifest.limitations,
    }),
  );
};
