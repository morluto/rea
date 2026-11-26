import {
  ArtifactReaderFailure,
  artifactParseFailure,
  type StableArtifactHandle,
} from "../../resources/index.js";
import type {
  InspectPeCertificatesInput,
  PeCertificates,
} from "../../domain/native/peCertificates.js";
import { peCertificateTypeName } from "../../domain/native/peCertificates.js";
import { BinaryReader } from "../../domain/binaryContainer.js";
import {
  malformedInput,
  truncatedInput,
  unsupportedInput,
} from "../../domain/parseFailure.js";
import {
  oidName,
  parsePkcs7SignedData,
  PeCertificateAsn1Failure,
  readAsn1,
} from "./PeCertificateAsn1.js";
import {
  readPeImage,
  readPeImageFromReader,
  type PeImage,
} from "../../domain/native/peImage.js";
import { peImageBaseHex } from "../../domain/native/peAddressSpace.js";
import { sha256Hex } from "../../kernel/sha256Hex.js";

/** The format the certificate table's own parser names in its failures. */
const FORMAT = "pe-certificate-table";

/** The bytes violate the certificate table's structure. */
const fail = (message: string, options?: ErrorOptions): never => {
  throw malformedInput(FORMAT, message, options);
};

/** A declared certificate structure starts in the bytes but ends past them. */
const failTruncated = (message: string): never => {
  throw truncatedInput(FORMAT, message);
};

const readCertificateImageAt = async (
  handle: StableArtifactHandle,
): Promise<PeImage> => {
  try {
    return await readPeImageFromReader(handle, "headers");
  } catch (cause) {
    throw artifactParseFailure(cause, undefined);
  }
};

const requireRange = (
  fileSize: number,
  offset: number,
  length: number,
): void => {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset > fileSize - length
  )
    failTruncated(
      `PE certificate range ${String(offset)} + ${String(length)} leaves the artifact.`,
    );
};

const align8 = (value: number): number => Math.ceil(value / 8) * 8;

/** Index key for an Authenticode signer: encoded issuer Name bytes plus serial. */
const issuerSerialKey = (issuer: Buffer, serialHex: string): string =>
  `${serialHex}:${issuer.toString("hex")}`;

/**
 * One WIN_CERTIFICATE inside IMAGE_DIRECTORY_ENTRY_SECURITY. Offsets are relative
 * to the certificate table start; `next` is the 8-byte-aligned successor offset.
 */
export interface WinCertificateEntryRange {
  readonly at: number;
  readonly length: number;
  readonly entryEnd: number;
  readonly next: number;
}

/**
 * Lazily walk every WIN_CERTIFICATE entry for structural bounds and alignment.
 * Throws {@link ParseFailureError} when the table is malformed or truncated so
 * callers can enforce entry limits without materializing the full table first.
 */
export function* readWinCertificateEntryRanges(
  table: Buffer,
): Generator<WinCertificateEntryRange> {
  const reader = new BinaryReader(table, true, FORMAT);
  let at = 0;
  while (at < table.length) {
    // Alignment padding sits inside the gap before the next 8-byte boundary.
    // Bytes that remain after that boundary are a short header, including
    // zeros at the start of the table.
    if (table.length - at < 8)
      failTruncated("WIN_CERTIFICATE header is truncated.");
    const length = reader.u32(at);
    if (length < 8)
      fail("WIN_CERTIFICATE dwLength is shorter than its header.");
    const entryEnd = at + length;
    if (entryEnd > table.length)
      fail("WIN_CERTIFICATE dwLength exceeds the certificate table.");
    const next = align8(entryEnd);
    if (next > table.length)
      failTruncated("WIN_CERTIFICATE alignment padding is truncated.");
    yield { at, length, entryEnd, next };
    at = next;
  }
}

const LIMITATIONS = [
  "This workflow does not verify signatures, certificate chains, timestamps, or Authenticode digest coverage of image bytes.",
  "PKCS#7 fields are decoded structurally; cryptographic validity remains unobserved.",
] as const;

const TELETEX_LIMITATION =
  "TeletexString values use OpenSSL's ISO-8859-1 compatibility mapping; this is not a full T.61 decoder.";

const UNSIGNED_ATTRIBUTES_LIMITATION =
  "Signer unsigned attribute contents are not decoded; nested signatures and timestamp token certificates and times may be omitted.";

const ABSENT_LIMITATIONS = [
  "IMAGE_DIRECTORY_ENTRY_SECURITY is absent. That is not proof the image is unsigned in every catalog or overlay sense.",
  "This workflow does not verify signatures, certificate chains, timestamps, or Authenticode digest coverage of image bytes.",
] as const;

/**
 * Locate IMAGE_DIRECTORY_ENTRY_SECURITY in a PE image. Returns null when the
 * directory is absent; throws {@link ParseFailureError} when it is present but
 * structurally invalid.
 */
export const certificateTableRange = (
  image: PeImage,
  fileSize: number,
): {
  readonly tableOffset: number;
  readonly tableSize: number;
  readonly directoryAt: number;
} | null => {
  const security = image.pe_data_directories[4];
  if (security === undefined || (security.address === 0 && security.size === 0))
    return null;
  const { address: tableOffset, size: tableSize } = security;
  if (tableSize === 0 || tableOffset < image.pe_size_of_headers)
    fail("PE certificate table offset overlaps headers or has zero size.");
  if (tableOffset % 8 !== 0)
    fail("PE certificate table offset must be aligned to eight bytes.");
  requireRange(fileSize, tableOffset, tableSize);
  return {
    tableOffset,
    tableSize,
    directoryAt: image.pe_optional_header_file_offset + security.offset,
  };
};

const parsePeCertificateTable = (
  image: PeImage,
  range: ReturnType<typeof certificateTableRange>,
  table: Buffer,
  artifact: PeCertificates["artifact"],
  input: InspectPeCertificatesInput,
  onSignerSubject?: (subject: string | undefined) => void,
): PeCertificates => {
  const format = image.bits === 64 ? "pe32-plus" : "pe32";
  const machine = image.pe_machine;
  const imageBase = peImageBaseHex(image.image_base);
  const headerAnomalies = [...image.pe_header_anomalies];
  if (range === null)
    return {
      artifact,
      format,
      machine,
      image_base: imageBase,
      table: null,
      entries: [],
      coverage: { status: "complete", examined_entries: 0, certificates: 0 },
      header_anomalies: headerAnomalies,
      limitations: [...ABSENT_LIMITATIONS],
    };
  const { tableOffset, tableSize, directoryAt } = range;
  if (table.length !== tableSize)
    throw new ArtifactReaderFailure(
      "integrity",
      "PE certificate table ended before its admitted extent.",
      { integrityCheck: "read-coverage" },
    );
  const entries: PeCertificates["entries"] = [];
  const reader = new BinaryReader(table, true, FORMAT);
  let examined = 0;
  let teletexStringCompatibilityUsed = false;
  let unsignedAttributesPresent = false;
  for (const { at, length, entryEnd } of readWinCertificateEntryRanges(table)) {
    if (examined >= input.max_entries)
      throw new ArtifactReaderFailure(
        "limit",
        `PE certificate table exceeds the ${String(input.max_entries)}-entry budget.`,
        { boundary: "capacity" },
      );
    examined += 1;
    const revision = reader.u16(at + 4);
    const certificateType = reader.u16(at + 6);
    const entryPayload = table.subarray(at + 8, entryEnd);
    let payload = entryPayload;
    let pkcs7: PeCertificates["entries"][number]["pkcs7"] = null;
    if (peCertificateTypeName(certificateType) === "pkcs7") {
      try {
        // dwLength may include the zero bytes that align the complete
        // WIN_CERTIFICATE to eight bytes. Bound CMS to its encoded ASN.1 root;
        // tolerate only the corresponding alignment bytes, never arbitrary
        // trailing data.
        const root = readAsn1(entryPayload);
        const paddingBytes = entryPayload.length - root.end;
        const alignedLength = align8(8 + root.end);
        if (
          paddingBytes !== 0 &&
          (8 + entryPayload.length !== alignedLength ||
            !entryPayload.subarray(root.end).every((byte) => byte === 0))
        )
          fail("WIN_CERTIFICATE has invalid PKCS#7 alignment padding.");
        payload = entryPayload.subarray(0, root.end);
        const parsed = parsePkcs7SignedData(root);
        if (onSignerSubject !== undefined) {
          const byIssuerSerial = new Map<
            string,
            { readonly subject: string; count: number }
          >();
          for (const certificate of parsed.certificates) {
            if (certificate.serial_hex === null) continue;
            const key = issuerSerialKey(
              payload.subarray(
                certificate.issuer.start,
                certificate.issuer.end,
              ),
              certificate.serial_hex,
            );
            const existing = byIssuerSerial.get(key);
            byIssuerSerial.set(key, {
              subject: certificate.subject.text,
              count: (existing?.count ?? 0) + 1,
            });
          }
          for (const signer of parsed.signers) {
            const issuer = signer.issuer;
            if (issuer === null || signer.serial_hex === null) {
              onSignerSubject(undefined);
              continue;
            }
            const match = byIssuerSerial.get(
              issuerSerialKey(
                payload.subarray(issuer.start, issuer.end),
                signer.serial_hex,
              ),
            );
            onSignerSubject(
              match !== undefined && match.count === 1
                ? match.subject
                : undefined,
            );
          }
        }
        teletexStringCompatibilityUsed ||=
          parsed.teletexStringCompatibilityUsed;
        unsignedAttributesPresent ||= parsed.signers.some(
          (signer) => signer.unsigned_attribute_oids !== null,
        );
        pkcs7 = {
          content_type_oid: parsed.content_type_oid,
          content_type_name: oidName(parsed.content_type_oid),
          digest_algorithm_oids: [...parsed.digest_algorithm_oids],
          certificates: parsed.certificates.map((certificate) => ({
            location: {
              offset: tableOffset + at + 8 + certificate.start,
              bytes: certificate.end - certificate.start,
            },
            der_sha256: sha256Hex(
              payload.subarray(certificate.start, certificate.end),
            ),
            serial_hex: certificate.serial_hex,
            issuer: {
              text: certificate.issuer.text,
              attributes: [...certificate.issuer.attributes],
            },
            subject: {
              text: certificate.subject.text,
              attributes: [...certificate.subject.attributes],
            },
            not_before: certificate.not_before,
            not_after: certificate.not_after,
            signature_algorithm_oid: certificate.signature_algorithm_oid,
            signature_algorithm_name: oidName(
              certificate.signature_algorithm_oid,
            ),
          })),
          signers: parsed.signers.map((signer) => ({
            digest_algorithm_oid: signer.digest_algorithm_oid,
            digest_algorithm_name: oidName(signer.digest_algorithm_oid),
            signature_algorithm_oid: signer.signature_algorithm_oid,
            signature_algorithm_name: oidName(signer.signature_algorithm_oid),
            issuer:
              signer.issuer === null
                ? null
                : {
                    text: signer.issuer.text,
                    attributes: [...signer.issuer.attributes],
                  },
            serial_hex: signer.serial_hex,
            subject_key_identifier_hex: signer.subject_key_identifier_hex,
            authenticated_attributes: signer.authenticated_attributes,
            unsigned_attribute_oids:
              signer.unsigned_attribute_oids === null
                ? null
                : [...signer.unsigned_attribute_oids],
          })),
        };
      } catch (cause) {
        // An exhausted decoder allowance is not evidence of malformed DER;
        // the provider reports it as a fixed resource allowance.
        if (
          cause instanceof PeCertificateAsn1Failure &&
          cause.exhausted === null
        ) {
          // A DER form outside the decoder's coverage is not corrupt bytes.
          if (cause.unsupportedForm)
            throw unsupportedInput(
              FORMAT,
              `PKCS#7 signedData uses an unsupported form: ${cause.message}`,
              { cause },
            );
          fail(`PKCS#7 signedData is malformed: ${cause.message}`, { cause });
        }
        throw cause;
      }
    }
    entries.push({
      index: entries.length,
      location: { offset: tableOffset + at, bytes: length },
      length,
      revision,
      certificate_type: certificateType,
      certificate_type_name: peCertificateTypeName(certificateType),
      payload: {
        location: { offset: tableOffset + at + 8, bytes: payload.length },
        bytes: payload.length,
        sha256: sha256Hex(payload),
      },
      pkcs7,
    });
  }
  const certificates = entries.reduce(
    (count, entry) => count + (entry.pkcs7?.certificates.length ?? 0),
    0,
  );
  return {
    artifact,
    format,
    machine,
    image_base: imageBase,
    table: {
      location: { offset: tableOffset, bytes: tableSize },
      data_directory_location: { offset: directoryAt, bytes: 8 },
    },
    entries,
    coverage: {
      status: unsignedAttributesPresent ? "partial" : "complete",
      examined_entries: examined,
      certificates,
    },
    header_anomalies: headerAnomalies,
    limitations: [
      ...LIMITATIONS,
      ...(teletexStringCompatibilityUsed ? [TELETEX_LIMITATION] : []),
      ...(unsignedAttributesPresent ? [UNSIGNED_ATTRIBUTES_LIMITATION] : []),
    ],
  };
};

/**
 * Decode IMAGE_DIRECTORY_ENTRY_SECURITY from a verified random-access handle,
 * reading only the PE headers and the WIN_CERTIFICATE table range.
 */
export const parsePeCertificatesFromHandle = async (
  handle: StableArtifactHandle,
  artifact: PeCertificates["artifact"],
  input: InspectPeCertificatesInput,
  onSignerSubject?: (subject: string | undefined) => void,
): Promise<PeCertificates> => {
  const image = await readCertificateImageAt(handle);
  const range = certificateTableRange(image, handle.size);
  const table =
    range === null
      ? Buffer.alloc(0)
      : await handle.readRange(range.tableOffset, range.tableSize);
  return parsePeCertificateTable(
    image,
    range,
    table,
    artifact,
    input,
    onSignerSubject,
  );
};

/**
 * Decode IMAGE_DIRECTORY_ENTRY_SECURITY from already-buffered PE bytes. Used by
 * the ASAR signed-after-packing explanation path after a mismatch.
 */
export const parsePeCertificatesFromBytes = (
  bytes: Buffer,
  artifact: PeCertificates["artifact"],
  input: InspectPeCertificatesInput,
  onSignerSubject?: (subject: string | undefined) => void,
): PeCertificates => {
  let image: PeImage;
  try {
    image = readPeImage(bytes, "headers");
  } catch (cause) {
    throw artifactParseFailure(cause, undefined);
  }
  const range = certificateTableRange(image, bytes.length);
  const table =
    range === null
      ? Buffer.alloc(0)
      : bytes.subarray(range.tableOffset, range.tableOffset + range.tableSize);
  return parsePeCertificateTable(
    image,
    range,
    table,
    artifact,
    input,
    onSignerSubject,
  );
};
