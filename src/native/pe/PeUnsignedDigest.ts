import type { SignedAfterPackingExplanation } from "../../domain/artifactIntegrity.js";
import {
  BinaryFormatFailure,
  BinaryReader,
} from "../../domain/binaryContainer.js";
import { readPeImage } from "../../domain/native/peImage.js";
import { sha256Hex } from "../../kernel/sha256Hex.js";
import { ArtifactReaderFailure } from "../../resources/index.js";
import { PeCertificateAsn1Failure } from "./PeCertificateAsn1.js";
import { parsePeCertificatesFromBytes } from "./PeCertificateParser.js";

/** Bound second-pass PE reads used only after an unpacked integrity mismatch. */
export const MAX_SIGNED_AFTER_PACKING_PE_BYTES = 67_108_864;

const CHECKSUM_OPTIONAL_HEADER_OFFSET = 64;

const align8 = (value: number): number => Math.ceil(value / 8) * 8;

/**
 * Confirm every WIN_CERTIFICATE entry is 8-byte aligned and in-bounds before
 * trusting the security directory's Size as a removable overlay.
 */
const certificateTableIsWellFormed = (table: Buffer): boolean => {
  const reader = new BinaryReader(table, true, "pe-certificate-table");
  let at = 0;
  while (at < table.length) {
    if (table.length - at < 8) return false;
    const length = reader.u32(at);
    if (length < 8) return false;
    const entryEnd = at + length;
    if (entryEnd > table.length) return false;
    const next = align8(entryEnd);
    if (next > table.length) return false;
    at = next;
  }
  return at === table.length;
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
  const security = image.pe_data_directories[4];
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
    tableOffset % 8 !== 0 ||
    tableOffset < image.pe_size_of_headers ||
    tableOffset > bytes.length - tableSize
  )
    return null;
  const directoryAt = image.pe_optional_header_file_offset + security.offset;
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
      cause instanceof BinaryFormatFailure
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
