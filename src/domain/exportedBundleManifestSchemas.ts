import { posix } from "node:path";

import { z } from "zod";

import {
  admitsCanonicalPathSyntax,
  looksExternal,
} from "./artifactPathSyntax.js";
import { digestCanonicalValue } from "./canonicalDigest.js";
import { digestSchema, prefixedDigestSchema } from "./digests.js";
import { err, ok, type Result } from "./result.js";
import { compareUnicodeCodePoints } from "./unicodeCodePointOrder.js";

/** Version of the exported analysis bundle manifest schema. */
export const EXPORTED_BUNDLE_MANIFEST_VERSION = 1 as const;

/** Default filename used when writing or reading a bundle manifest in a directory. */
export const EXPORTED_BUNDLE_MANIFEST_FILENAME =
  "rea-bundle-manifest.json" as const;

/** Scope note required by #6337: integrity verification is not trust or correctness attestation. */
export const EXPORTED_BUNDLE_MANIFEST_SCOPE_LIMITATION =
  "Manifest verification establishes that bundle files match recorded digests and sizes; it does not establish that the analysis is correct or that the manifest itself is trusted." as const;

const MAX_PATH_SEGMENT_UTF8_BYTES = 255;
const PERCENT_ENCODED_PATH_CONTROL = /%(?:2e|2f|5c|00)/iu;
const WINDOWS_RESERVED_BASENAME =
  /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
const WINDOWS_FORBIDDEN_SEGMENT_CHARS = /[<>:"|?*]/u;

export const foldBundlePathCase = (pathValue: string): string =>
  pathValue
    .normalize("NFC")
    .toUpperCase()
    .toLowerCase()
    .replace(/i\u0307/gu, "i");

const hasControlCharacters = (value: string): boolean => {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
};

const isInvalidPathSegment = (segment: string): string | undefined => {
  if (segment.length === 0 || segment === "." || segment === "..") {
    return "contains empty or traversal segment";
  }
  if (Buffer.byteLength(segment, "utf8") > MAX_PATH_SEGMENT_UTF8_BYTES) {
    return `exceeds ${String(MAX_PATH_SEGMENT_UTF8_BYTES)}-byte UTF-8 segment limit`;
  }
  if (
    segment.endsWith(".") ||
    segment.endsWith(" ") ||
    WINDOWS_FORBIDDEN_SEGMENT_CHARS.test(segment) ||
    WINDOWS_RESERVED_BASENAME.test(segment)
  ) {
    return "contains non-portable Windows device name or forbidden segment characters";
  }
  return undefined;
};

/**
 * Normalize and validate a bundle-relative file path.
 * Rejects empty paths, lone surrogates, control chars, backslashes, leading/trailing slashes,
 * drive/scheme prefixes, `.` or `..` traversal segments, >255-byte UTF-8 segments,
 * Windows reserved device names, and the manifest file itself.
 */
export const normalizeExportedBundleRelativePath = (
  input: string,
): Result<string, string> => {
  if (input.length === 0) {
    return err("Bundle entry relative_path must not be empty");
  }
  if (/[\uD800-\uDFFF]/u.test(input) || hasControlCharacters(input)) {
    return err(
      `Bundle entry relative_path contains ill-formed UTF-16 or control characters: ${JSON.stringify(input)}`,
    );
  }
  const normalized = input.normalize("NFC");
  if (normalized !== input)
    return err(
      `Bundle entry path must use canonical Unicode NFC normalization: ${JSON.stringify(input)}`,
    );
  if (
    !admitsCanonicalPathSyntax(normalized) ||
    looksExternal(normalized) ||
    PERCENT_ENCODED_PATH_CONTROL.test(normalized)
  ) {
    return err(
      `Bundle entry relative_path is not a safe relative path: ${JSON.stringify(input)}`,
    );
  }
  const segments = normalized.split("/");
  if (posix.normalize(normalized) !== normalized) {
    return err(
      `Bundle entry relative_path contains traversal or unnormalized segments: ${JSON.stringify(input)}`,
    );
  }
  for (const segment of segments) {
    const segmentError = isInvalidPathSegment(segment);
    if (segmentError !== undefined) {
      return err(
        `Bundle entry relative_path ${segmentError}: ${JSON.stringify(input)}`,
      );
    }
  }
  const folded = foldBundlePathCase(normalized);
  if (
    folded === foldBundlePathCase(EXPORTED_BUNDLE_MANIFEST_FILENAME) ||
    folded.startsWith(
      `.${foldBundlePathCase(EXPORTED_BUNDLE_MANIFEST_FILENAME)}.tmp`,
    )
  ) {
    return err(
      `Bundle entry relative_path must not reference the manifest file itself (${EXPORTED_BUNDLE_MANIFEST_FILENAME})`,
    );
  }
  return ok(normalized);
};

/** Predicate checking whether a string is already a canonical bundle-relative path. */
export const isExportedBundleRelativePath = (input: string): boolean => {
  const normalized = normalizeExportedBundleRelativePath(input);
  return normalized.ok && normalized.value === input;
};

export const exportedBundleRelativePathSchema = z
  .string()
  .min(1)
  .refine(isExportedBundleRelativePath, {
    message:
      "Bundle entry relative_path must be a normalized portable relative path without '.', '..', backslashes, schemes, >255-byte segments, or self-reference",
  });

export const exportedBundleKindSchema = z.enum([
  "evidence-bundle",
  "decompile-directory",
  "web-script-export",
  "environment-bundle",
  "analysis-bundle",
]);

export type ExportedBundleKind = z.infer<typeof exportedBundleKindSchema>;

const unavailableProvenanceSectionSchema = z.strictObject({
  available: z.literal(false),
  reason: z.string().min(1),
});

export const exportedBundleArtifactProvenanceSchema = z.discriminatedUnion(
  "available",
  [
    z.strictObject({
      available: z.literal(true),
      sha256: digestSchema,
      format: z.string().min(1),
      architecture: z.string().min(1).nullable(),
    }),
    unavailableProvenanceSectionSchema,
  ],
);

export const exportedBundleProviderProvenanceSchema = z.discriminatedUnion(
  "available",
  [
    z.strictObject({
      available: z.literal(true),
      id: z.string().min(1),
      name: z.string().min(1),
      version: z.string().min(1).nullable(),
    }),
    unavailableProvenanceSectionSchema,
  ],
);

export const exportedBundleProfileProvenanceSchema = z.discriminatedUnion(
  "available",
  [
    z.strictObject({
      available: z.literal(true),
      digest: digestSchema,
    }),
    unavailableProvenanceSectionSchema,
  ],
);

const evidenceIdSchema = prefixedDigestSchema("ev");

const isStrictlySortedCodePointOrder = (values: readonly string[]): number => {
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1];
    const current = values[index];
    if (
      previous !== undefined &&
      current !== undefined &&
      compareUnicodeCodePoints(previous, current) >= 0
    ) {
      return index;
    }
  }
  return -1;
};

export const exportedBundleProvenanceSchema = z
  .strictObject({
    artifact: exportedBundleArtifactProvenanceSchema,
    provider: exportedBundleProviderProvenanceSchema,
    analysis_profile: exportedBundleProfileProvenanceSchema,
    source_evidence_ids: z.array(evidenceIdSchema),
  })
  .superRefine((provenance, context) => {
    const badIndex = isStrictlySortedCodePointOrder(
      provenance.source_evidence_ids,
    );
    if (badIndex !== -1) {
      context.addIssue({
        code: "custom",
        path: ["source_evidence_ids", badIndex],
        message:
          "source_evidence_ids must be strictly sorted in canonical Unicode code-point order without duplicates",
      });
    }
  });

export type ExportedBundleProvenance = z.infer<
  typeof exportedBundleProvenanceSchema
>;

export const exportedBundleEntrySchema = z.strictObject({
  relative_path: exportedBundleRelativePathSchema,
  sha256: digestSchema,
  bytes: z.int().min(0),
  role: z.string().min(1).nullable(),
});

export type ExportedBundleEntry = z.infer<typeof exportedBundleEntrySchema>;

export const exportedBundleSummarySchema = z.strictObject({
  file_count: z.int().min(0),
  total_bytes: z.int().min(0),
});

export const unsignedExportedBundleManifestSchema = z.strictObject({
  schema_version: z.literal(EXPORTED_BUNDLE_MANIFEST_VERSION),
  bundle_kind: exportedBundleKindSchema,
  provenance: exportedBundleProvenanceSchema,
  summary: exportedBundleSummarySchema,
  entries: z.array(exportedBundleEntrySchema),
  limitations: z.array(z.string().min(1)),
});

export type UnsignedExportedBundleManifest = z.infer<
  typeof unsignedExportedBundleManifestSchema
>;

const findPathConflict = (
  paths: readonly string[],
):
  | {
      readonly kind: "prefix" | "case_collision";
      readonly first: string;
      readonly second: string;
    }
  | undefined => {
  const seenFolded = new Map<string, string>();
  const foldedList: { readonly raw: string; readonly folded: string }[] = [];
  for (const raw of paths) {
    const folded = foldBundlePathCase(raw);
    const existing = seenFolded.get(folded);
    if (existing !== undefined && existing !== raw) {
      return { kind: "case_collision", first: existing, second: raw };
    }
    seenFolded.set(folded, raw);
    foldedList.push({ raw, folded });
  }
  const sortedByFolded = [...foldedList].sort((a, b) =>
    compareUnicodeCodePoints(a.folded, b.folded),
  );
  for (let index = 1; index < sortedByFolded.length; index += 1) {
    const previous = sortedByFolded[index - 1];
    const current = sortedByFolded[index];
    if (
      previous !== undefined &&
      current !== undefined &&
      current.folded.startsWith(`${previous.folded}/`)
    ) {
      return { kind: "prefix", first: previous.raw, second: current.raw };
    }
  }
  return undefined;
};

/** Compute the canonical SHA-256 digest committing the unsigned manifest content. */
export const computeExportedBundleManifestDigest = (
  unsignedManifest: UnsignedExportedBundleManifest,
): string => digestCanonicalValue(unsignedManifest, "Exported bundle manifest");

export const exportedBundleManifestSchema = unsignedExportedBundleManifestSchema
  .extend({
    manifest_sha256: digestSchema,
  })
  .strict()
  .superRefine((manifest, context) => {
    const entryPaths = manifest.entries.map((entry) => entry.relative_path);
    const badEntryIndex = isStrictlySortedCodePointOrder(entryPaths);
    if (badEntryIndex !== -1) {
      context.addIssue({
        code: "custom",
        path: ["entries", badEntryIndex, "relative_path"],
        message:
          "Manifest entries must be strictly sorted by relative_path in Unicode code-point order without duplicates",
      });
    }

    const conflict = findPathConflict(entryPaths);
    if (conflict !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["entries"],
        message:
          conflict.kind === "case_collision"
            ? `Manifest entries contain case-colliding relative paths: ${JSON.stringify(conflict.first)} and ${JSON.stringify(conflict.second)}`
            : `Manifest entries contain conflicting file/directory path prefixes: ${JSON.stringify(conflict.first)} and ${JSON.stringify(conflict.second)}`,
      });
    }

    const badLimitationIndex = isStrictlySortedCodePointOrder(
      manifest.limitations,
    );
    if (badLimitationIndex !== -1) {
      context.addIssue({
        code: "custom",
        path: ["limitations", badLimitationIndex],
        message:
          "Manifest limitations must be strictly sorted in Unicode code-point order without duplicates",
      });
    }

    const expectedFileCount = manifest.entries.length;
    const expectedTotalBytes = manifest.entries.reduce(
      (sum, entry) => sum + entry.bytes,
      0,
    );
    if (manifest.summary.file_count !== expectedFileCount) {
      context.addIssue({
        code: "custom",
        path: ["summary", "file_count"],
        message: `summary.file_count (${String(manifest.summary.file_count)}) does not match entries.length (${String(expectedFileCount)})`,
      });
    }
    if (manifest.summary.total_bytes !== expectedTotalBytes) {
      context.addIssue({
        code: "custom",
        path: ["summary", "total_bytes"],
        message: `summary.total_bytes (${String(manifest.summary.total_bytes)}) does not match sum of entry bytes (${String(expectedTotalBytes)})`,
      });
    }

    const { manifest_sha256: recordedDigest, ...unsigned } = manifest;
    const expectedDigest = computeExportedBundleManifestDigest(unsigned);
    if (recordedDigest !== expectedDigest) {
      context.addIssue({
        code: "custom",
        path: ["manifest_sha256"],
        message: `manifest_sha256 mismatch: expected ${expectedDigest}, got ${recordedDigest}`,
      });
    }
  });

export type ExportedBundleManifest = z.infer<
  typeof exportedBundleManifestSchema
>;

export const observedBundleEntryKindSchema = z.enum([
  "file",
  "symlink",
  "directory",
  "other",
]);

export type ObservedBundleEntryKind = z.infer<
  typeof observedBundleEntryKindSchema
>;

export interface ObservedBundleFileSystemEntry {
  readonly relative_path: string;
  readonly kind?: ObservedBundleEntryKind;
  readonly sha256?: string | null;
  readonly bytes?: number | null;
}

export const exportedBundleVerificationFindingKindSchema = z.enum([
  "manifest_integrity_failed",
  "invalid_entry_path",
  "duplicate_observed_path",
  "non_regular_entry",
  "missing_file",
  "unexpected_file",
  "size_mismatch",
  "digest_mismatch",
]);

export type ExportedBundleVerificationFindingKind = z.infer<
  typeof exportedBundleVerificationFindingKindSchema
>;

export const exportedBundleVerificationFindingSchema = z.strictObject({
  kind: exportedBundleVerificationFindingKindSchema,
  relative_path: z.string().nullable(),
  expected_sha256: digestSchema.nullable(),
  observed_sha256: digestSchema.nullable(),
  expected_bytes: z.int().min(0).nullable(),
  observed_bytes: z.int().min(0).nullable(),
  message: z.string().min(1),
});

export type ExportedBundleVerificationFinding = z.infer<
  typeof exportedBundleVerificationFindingSchema
>;

export const exportedBundleVerificationReportSchema = z.strictObject({
  verified: z.boolean(),
  status: z.enum(["verified", "failed", "invalid_manifest"]),
  manifest_sha256: digestSchema.nullable(),
  bundle_kind: exportedBundleKindSchema.nullable(),
  summary: z.strictObject({
    expected_files: z.int().min(0),
    observed_files: z.int().min(0),
    verified_files: z.int().min(0),
    missing_files: z.int().min(0),
    modified_files: z.int().min(0),
    unexpected_files: z.int().min(0),
    invalid_entries: z.int().min(0),
  }),
  findings: z.array(exportedBundleVerificationFindingSchema),
  limitations: z.array(z.string().min(1)),
});

export type ExportedBundleVerificationReport = z.infer<
  typeof exportedBundleVerificationReportSchema
>;
