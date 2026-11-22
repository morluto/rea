import {
  ArtifactReaderFailure,
  artifactParseFailure,
} from "../../resources/index.js";
import type {
  InspectPeCertificatesInput,
  PeCertificates,
} from "../../domain/native/peCertificates.js";
import { peCertificateTypeName } from "../../domain/native/peCertificates.js";
import { BinaryReader } from "../../domain/binaryContainer.js";
import {
  oidName,
  parsePkcs7SignedData,
  PeCertificateAsn1Failure,
  readAsn1,
} from "./PeCertificateAsn1.js";
import { readPeImageHeaders } from "../../domain/pe/peImageHeaders.js";
import {
  admitPeSecurityDirectory,
  PE_SECURITY_DIRECTORY_DEFECTS,
} from "../../domain/pe/peSecurityDirectory.js";
import { sha256Hex } from "../../kernel/sha256Hex.js";

const fail = (message: string): never => {
  throw new ArtifactReaderFailure("format", message);
};

/** Shared PE header admission, with malformed headers as format failures. */
const readCertificateImageHeaders = (bytes: Buffer) => {
  try {
    return readPeImageHeaders(bytes);
  } catch (cause) {
    throw artifactParseFailure(cause, undefined);
  }
};

const align8 = (value: number): number => Math.ceil(value / 8) * 8;

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

/** Decode IMAGE_DIRECTORY_ENTRY_SECURITY as a file-offset WIN_CERTIFICATE table. */
export const parsePeCertificates = (
  bytes: Buffer,
  artifact: PeCertificates["artifact"],
  input: InspectPeCertificatesInput,
): PeCertificates => {
  const { machine, format, dataDirectories, headerSize, optionalHeaderOffset } =
    readCertificateImageHeaders(bytes);
  const security = dataDirectories[4];
  const admitted = admitPeSecurityDirectory(security, headerSize, bytes.length);
  if (admitted.status === "absent" || security === undefined) {
    return {
      artifact,
      format,
      machine,
      table: null,
      entries: [],
      coverage: { status: "complete", examined_entries: 0, certificates: 0 },
      limitations: [...ABSENT_LIMITATIONS],
    };
  }
  if (admitted.status === "malformed")
    fail(
      `${PE_SECURITY_DIRECTORY_DEFECTS[admitted.defect]} Declared range: offset ${String(admitted.offset)}, size ${String(admitted.size)}.`,
    );
  const { offset: tableOffset, size: tableSize } = admitted;
  const directoryAt = optionalHeaderOffset + security.offset;
  const table = bytes.subarray(tableOffset, tableOffset + tableSize);
  const entries: PeCertificates["entries"] = [];
  let at = 0;
  const reader = new BinaryReader(table, true, "pe-certificate-table");
  let examined = 0;
  let teletexStringCompatibilityUsed = false;
  let unsignedAttributesPresent = false;
  while (at < table.length) {
    // Alignment padding sits inside the gap before the next 8-byte boundary.
    // Bytes that remain after that boundary are a short header, including
    // zeros at the start of the table.
    if (table.length - at < 8) fail("WIN_CERTIFICATE header is truncated.");
    const length = reader.u32(at);
    if (length < 8)
      fail("WIN_CERTIFICATE dwLength is shorter than its header.");
    const entryEnd = at + length;
    if (entryEnd > table.length)
      fail("WIN_CERTIFICATE dwLength exceeds the certificate table.");
    const next = align8(entryEnd);
    if (next > table.length)
      fail("WIN_CERTIFICATE alignment padding is truncated.");
    examined += 1;
    if (examined > input.max_entries)
      throw new ArtifactReaderFailure(
        "limit",
        `PE certificate table exceeds the ${String(input.max_entries)}-entry budget.`,
        { boundary: "capacity" },
      );
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
        )
          fail(`PKCS#7 signedData is malformed: ${cause.message}`);
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
    at = next;
  }
  const certificates = entries.reduce(
    (count, entry) => count + (entry.pkcs7?.certificates.length ?? 0),
    0,
  );
  return {
    artifact,
    format,
    machine,
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
    limitations: [
      ...LIMITATIONS,
      ...(teletexStringCompatibilityUsed ? [TELETEX_LIMITATION] : []),
      ...(unsignedAttributesPresent ? [UNSIGNED_ATTRIBUTES_LIMITATION] : []),
    ],
  };
};
