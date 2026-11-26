import type { SignedAfterPackingExplanation } from "../../domain/artifactIntegrity.js";
import { BinaryFormatFailure } from "../../domain/binaryContainer.js";
import { ParseFailureError } from "../../domain/parseFailure.js";
import { readPeImage } from "../../domain/native/peImage.js";
import { sha256Hex } from "../../kernel/sha256Hex.js";
import { ArtifactReaderFailure } from "../../resources/index.js";
import { PeCertificateAsn1Failure } from "./PeCertificateAsn1.js";
import {
  certificateTableRange,
  parsePeCertificatesFromBytes,
  readWinCertificateEntryRanges,
} from "./PeCertificateParser.js";

/**
 * Bound for the optional in-memory PE reconstruction used only after an
 * unpacked integrity mismatch. Authenticode rebuild needs the whole image as
 * one buffer; this representation ceiling is fixed for the release.
 */
export const MAX_SIGNED_AFTER_PACKING_PE_BYTES = 67_108_864;

const CHECKSUM_OPTIONAL_HEADER_OFFSET = 64;

/**
 * Confirm every WIN_CERTIFICATE entry is 8-byte aligned and in-bounds before
 * trusting the security directory's Size as a removable overlay.
 */
const certificateTableIsWellFormed = (table: Buffer): boolean => {
  try {
    for (const _entry of readWinCertificateEntryRanges(table)) {
      // Consuming the generator verifies every entry header, length, and
      // 8-byte alignment bound without retaining an array of all entries.
    }
    return true;
  } catch (cause) {
    if (cause instanceof ParseFailureError) return false;
    throw cause;
  }
};

/**
 * Rebuild PE file bytes as they would appear before Authenticode appended
 * IMAGE_DIRECTORY_ENTRY_SECURITY: remove that table's exact file range, zero the
 * security directory, and zero IMAGE_OPTIONAL_HEADER.CheckSum.
 *
 * Returns null when the image has no usable security directory or the range is
 * invalid. Does not claim the result is Authenticode-valid; it is only a
 * deterministic byte reconstruction for digest comparison.
 */
export const rebuildPeBytesWithoutCertificateTable = (
  bytes: Buffer,
): {
  readonly bytes: Buffer;
  readonly certificateTableBytes: number;
} | null => {
  let image: ReturnType<typeof readPeImage>;
  try {
    image = readPeImage(bytes, "headers");
  } catch (cause) {
    if (cause instanceof BinaryFormatFailure) return null;
    throw cause;
  }
  let range: ReturnType<typeof certificateTableRange>;
  try {
    range = certificateTableRange(image, bytes.length);
  } catch (cause) {
    if (cause instanceof ParseFailureError) return null;
    throw cause;
  }
  if (range === null) return null;
  const { tableOffset, tableSize, directoryAt } = range;
  if (directoryAt + 8 > tableOffset) return null;
  if (
    !certificateTableIsWellFormed(
      bytes.subarray(tableOffset, tableOffset + tableSize),
    )
  )
    return null;
  const rebuilt = Buffer.allocUnsafe(bytes.length - tableSize);
  bytes.copy(rebuilt, 0, 0, tableOffset);
  bytes.copy(rebuilt, tableOffset, tableOffset + tableSize);
  rebuilt.writeUInt32LE(
    0,
    image.pe_optional_header_file_offset + CHECKSUM_OPTIONAL_HEADER_OFFSET,
  );
  rebuilt.writeUInt32LE(0, directoryAt);
  rebuilt.writeUInt32LE(0, directoryAt + 4);
  return { bytes: rebuilt, certificateTableBytes: tableSize };
};

const signerSubjectsFromCertificateTable = (
  bytes: Buffer,
): {
  readonly subjects: string[];
  readonly complete: boolean;
} => {
  const subjects: string[] = [];
  const seen = new Set<string>();
  let complete = true;
  try {
    const report = parsePeCertificatesFromBytes(
      bytes,
      {
        path: "<asar-unpacked-pe>",
        sha256: sha256Hex(bytes),
        bytes: bytes.length,
      },
      {
        path: "/asar-unpacked-pe",
        max_file_bytes: bytes.length,
        max_entries: 64,
      },
      (subject) => {
        if (subject === undefined) {
          complete = false;
          return;
        }
        if (!seen.has(subject)) {
          seen.add(subject);
          subjects.push(subject);
        }
      },
    );
    if (
      report.coverage.status !== "complete" ||
      report.entries.some(({ pkcs7 }) => pkcs7 === null)
    )
      complete = false;
    return { subjects, complete };
  } catch (cause) {
    if (
      cause instanceof ArtifactReaderFailure ||
      cause instanceof PeCertificateAsn1Failure ||
      cause instanceof BinaryFormatFailure ||
      cause instanceof ParseFailureError
    )
      return { subjects, complete: false };
    throw cause;
  }
};

/**
 * When an unpacked PE's observed SHA-256 disagrees with the ASAR claim, check
 * whether removing Authenticode restores the declared digest. Match is exact;
 * any other mutation stays an unexplained mismatch.
 *
 * Returns null when reconstruction does not restore the claim. Callers must
 * apply {@link MAX_SIGNED_AFTER_PACKING_PE_BYTES} (and any acquisition budget)
 * before buffering bytes and report when that skip happens.
 */
export const explainPeSignedAfterPacking = (
  bytes: Buffer,
  declaredSha256: string,
): SignedAfterPackingExplanation | null => {
  if (bytes.length > MAX_SIGNED_AFTER_PACKING_PE_BYTES) return null;
  const rebuilt = rebuildPeBytesWithoutCertificateTable(bytes);
  if (rebuilt === null) return null;
  const unsignedSha256 = sha256Hex(rebuilt.bytes);
  if (unsignedSha256 !== declaredSha256) return null;
  const signers = signerSubjectsFromCertificateTable(bytes);
  return {
    kind: "signed-after-packing",
    platform: "pe-authenticode",
    unsigned_sha256: unsignedSha256,
    certificate_table_bytes: rebuilt.certificateTableBytes,
    signer_subjects: signers.subjects,
    signer_subjects_complete: signers.complete,
  };
};

/** Limitation text when the optional PE reconstruction budget refuses the companion. */
export const signedAfterPackingBudgetLimitation = (
  observedBytes: number,
  maximumBytes: number,
): string =>
  `Signing explanation skipped: PE companion of ${String(observedBytes)} bytes exceeds the ${String(maximumBytes)}-byte signed-after-packing reconstruction allowance.`;
