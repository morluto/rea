import { createHash } from "node:crypto";

import type { SignedAfterPackingExplanation } from "../../domain/artifactIntegrity.js";
import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import { parsePeCertificates } from "./PeCertificateParser.js";
import { readPeHeaders } from "./PeResourceLayout.js";
import { PeCertificateAsn1Failure } from "./PeCertificateAsn1.js";

/** Bound second-pass PE reads used only after an unpacked integrity mismatch. */
export const MAX_SIGNED_AFTER_PACKING_PE_BYTES = 67_108_864;

const CHECKSUM_OPTIONAL_HEADER_OFFSET = 64;

const sha256Hex = (bytes: Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");

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
  let headers: ReturnType<typeof readPeHeaders>;
  try {
    headers = readPeHeaders(bytes);
  } catch (cause) {
    if (cause instanceof ArtifactReaderFailure) return null;
    throw cause;
  }
  const { dataDirectories, optionalHeaderOffset } = headers;
  const security = dataDirectories[4];
  if (
    security === undefined ||
    (security.address === 0 && security.size === 0) ||
    security.size === 0
  )
    return null;
  const tableOffset = security.address;
  const tableSize = security.size;
  if (
    !Number.isSafeInteger(tableOffset) ||
    !Number.isSafeInteger(tableSize) ||
    tableOffset < headers.headerSize ||
    tableOffset > bytes.length - tableSize
  )
    return null;
  const directoryAt = optionalHeaderOffset + security.offset;
  if (directoryAt + 8 > tableOffset) return null;
  const rebuilt = Buffer.allocUnsafe(bytes.length - tableSize);
  bytes.copy(rebuilt, 0, 0, tableOffset);
  bytes.copy(rebuilt, tableOffset, tableOffset + tableSize);
  rebuilt.writeUInt32LE(
    0,
    optionalHeaderOffset + CHECKSUM_OPTIONAL_HEADER_OFFSET,
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
    const report = parsePeCertificates(
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
      cause instanceof PeCertificateAsn1Failure
    )
      return { subjects, complete: false };
    throw cause;
  }
};

/**
 * When an unpacked PE's observed SHA-256 disagrees with the ASAR claim, check
 * whether removing Authenticode restores the declared digest. Match is exact;
 * any other mutation stays an unexplained mismatch.
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
