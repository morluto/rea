/**
 * Read each v1 (JAR) signer's PKCS#7 block from the archive and materialise
 * its declared facts. The domain owns the ZIP and DER structure; this adapter
 * owns inflation (bounded by the inflater itself, not the declared size) and
 * hands every certificate to the shared certificate owner.
 */
import { createInflateRaw } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { err, ok, type Result } from "../domain/result.js";
import { isAbortWithReason } from "../process/SignalAbort.js";
import { ArtifactReaderFailure } from "../resources/index.js";

import type { ApkSignatureResult } from "../domain/apkSignature/apkSignatureReport.js";
import {
  centralDeclaresEncryption,
  parseLocalEntryHeader,
  type ApkV1SignerEntry,
} from "../domain/apkSignature/apkV1Signature.js";
import { ZIP_LOCAL_HEADER_BYTES } from "../domain/zip/zipLocalHeader.js";
import {
  decodeV1SignatureBlock,
  type ApkV1SignedData,
} from "../domain/apkSignature/apkV1SignatureBlock.js";
import {
  certificateBytes,
  certificateFacts,
  certificateSummaryBytes,
  jsonStringBytes,
  type Certificate,
} from "./apkCertificateFacts.js";
import { APK_SIGNATURE_LIMITS } from "./ApkSignatureRelease.js";

type V1Signer = ApkSignatureResult["schemes"]["v1"]["signers"][number];

/** One v1 signer: its decoded SignedData, or why it could not be read. */
export interface DecodedV1Signer {
  readonly entry: ApkV1SignerEntry;
  /** The block's local or central header sets the encryption flag (bit 0). */
  readonly declaresEncryption: boolean;
  readonly decoded:
    | { readonly ok: true; readonly value: ApkV1SignedData }
    | { readonly ok: false; readonly error: string };
}

/**
 * One serialized SignerInfo: two OIDs of at most 64 content bytes, each at
 * most 4 dotted-text bytes per content byte, plus a fingerprint and keys.
 */
const SIGNER_INFO_BYTES = 768;

/** Upper bound on one v1 signer's serialized size, before it is materialised. */
export const projectedV1SignerBytes = ({
  entry,
  decoded,
}: DecodedV1Signer): number => {
  const total =
    512 +
    jsonStringBytes(entry.signatureFile) +
    jsonStringBytes(entry.block.name);
  if (!decoded.ok) return total + jsonStringBytes(decoded.error);
  const { certificates, signerInfos } = decoded.value;
  // Every certificate is summarised in `certificates`; at most one, the
  // named signer, also appears in full as `certificate`.
  let largest = 0;
  let summaries = 0;
  for (const der of certificates) {
    summaries += certificateSummaryBytes(der);
    largest = Math.max(largest, certificateBytes(der));
  }
  return total + summaries + largest + SIGNER_INFO_BYTES * signerInfos.length;
};

const inflateSignerBlock = async (
  reader: {
    readonly readRange: (offset: number, length: number) => Promise<Uint8Array>;
  },
  start: number,
  end: number,
  limit: number,
): Promise<Result<Uint8Array, string>> => {
  const chunkBytes = 64 * 1024;
  const output: Buffer[] = [];
  let outputBytes = 0;
  let suppliedBytes = 0;
  const inflater = createInflateRaw();
  const exceeded = new Error("APK signer inflation bound exceeded");
  let readingFailed = false;
  let readFailure: unknown;
  try {
    await pipeline(
      (async function* () {
        for (let offset = start; offset < end;) {
          const expected = Math.min(chunkBytes, end - offset);
          let chunk: Uint8Array;
          try {
            chunk = await reader.readRange(offset, expected);
            if (chunk.length !== expected)
              throw new ArtifactReaderFailure(
                "integrity",
                "APK signature block ended before its admitted extent",
                { integrityCheck: "read-coverage" },
              );
          } catch (cause) {
            readingFailed = true;
            readFailure = cause;
            throw cause;
          }
          suppliedBytes += chunk.length;
          yield chunk;
          offset += expected;
        }
      })(),
      inflater,
      async (chunks: AsyncIterable<Buffer>) => {
        for await (const chunk of chunks) {
          outputBytes += chunk.length;
          if (outputBytes > limit) throw exceeded;
          output.push(chunk);
        }
      },
    );
  } catch (cause) {
    if (readingFailed) throw readFailure;
    if (cause === exceeded)
      return err(
        `signature block inflates past the ${String(limit)}-byte bound`,
      );
    const code =
      cause instanceof Error && "code" in cause ? cause.code : undefined;
    // With trailing bytes, zlib can emit EOF before pipeline finishes feeding
    // the range. Retain the decoded stream only when zlib confirmed EOF and
    // left input unused. Physical failures above still take precedence.
    const reachedDeflateEnd =
      (code === "ERR_STREAM_PREMATURE_CLOSE" ||
        (cause instanceof Error && isAbortWithReason(cause, undefined))) &&
      inflater.readableEnded &&
      inflater.bytesWritten < suppliedBytes;
    if (!reachedDeflateEnd) {
      if (
        code === "Z_DATA_ERROR" ||
        code === "Z_BUF_ERROR" ||
        code === "Z_NEED_DICT"
      )
        return err("signature block deflate stream is damaged");
      throw cause;
    }
  }
  return ok(Buffer.concat(output, outputBytes));
};

/**
 * Read one v1 signature block's header and payload via random-access range
 * reads without buffering the whole archive.
 */
export const decodeV1SignerFromReader = async (
  reader: {
    readonly size: number;
    readonly readRange: (offset: number, length: number) => Promise<Uint8Array>;
  },
  entry: ApkV1SignerEntry,
  entriesEnd: number,
): Promise<DecodedV1Signer> => {
  const { block } = entry;
  let declaresEncryption = centralDeclaresEncryption(block);
  const fail = (error: string): DecodedV1Signer => ({
    entry,
    declaresEncryption,
    decoded: { ok: false, error },
  });
  if (entry.duplicate !== null)
    return fail(`duplicate entry: ${entry.duplicate}`);
  const limit = APK_SIGNATURE_LIMITS.v1BlockBytes;
  const maxEnd = Math.min(entriesEnd, reader.size);
  const at = block.localHeaderOffset;
  const headerSlice =
    at !== 0xffffffff && at >= 0 && at + ZIP_LOCAL_HEADER_BYTES <= maxEnd
      ? await reader.readRange(
          at,
          Math.min(ZIP_LOCAL_HEADER_BYTES + block.rawName.length, maxEnd - at),
        )
      : new Uint8Array(0);
  const header = parseLocalEntryHeader(
    headerSlice,
    block,
    entriesEnd,
    reader.size,
  );
  if (!header.ok) return fail(header.error.detail);
  ({ declaresEncryption } = header.value);
  if (block.uncompressedSize > limit)
    return fail(
      `signature block declares ${String(block.uncompressedSize)} bytes, over the ${String(limit)}-byte bound`,
    );
  const { dataStart, dataEnd } = header.value;
  let data: Uint8Array;
  switch (block.method) {
    case 0:
      if (dataEnd - dataStart !== block.uncompressedSize)
        return fail(
          `signature block holds ${String(dataEnd - dataStart)} bytes, the central directory declares ${String(block.uncompressedSize)}`,
        );
      data = await reader.readRange(dataStart, dataEnd - dataStart);
      break;
    case 8: {
      const inflated = await inflateSignerBlock(
        reader,
        dataStart,
        dataEnd,
        limit,
      );
      if (!inflated.ok) return fail(inflated.error);
      data = inflated.value;
      break;
    }
    default:
      return fail(
        `compression method ${String(block.method)} is not supported`,
      );
  }
  if (data.length !== block.uncompressedSize)
    return fail(
      `signature block holds ${String(data.length)} bytes, the central directory declares ${String(block.uncompressedSize)}`,
    );
  const signedData = decodeV1SignatureBlock(data);
  if (signedData.ok) return { entry, declaresEncryption, decoded: signedData };
  return fail(
    signedData.error.kind === "malformed-pkcs7"
      ? `malformed PKCS#7: ${signedData.error.detail}`
      : `more ${signedData.error.resource} than ${String(signedData.error.limit)}`,
  );
};

/** Facts about v1 blocks that the report has no field for. */
export const v1SignerNotes = (signers: readonly DecodedV1Signer[]): string[] =>
  signers.flatMap(({ entry, declaresEncryption, decoded }) => [
    ...(declaresEncryption
      ? [
          `${entry.block.name}: the entry declares encryption (general-purpose flag bit 0); apksig ignores the flag, so its bytes were read as stored and the PKCS#7 decoding decides.`,
        ]
      : []),
    ...(decoded.ok &&
    decoded.value.signerInfos.some(
      (info) => info.identifiedBy === "subject-key-identifier",
    )
      ? [
          `${entry.block.name}: a SignerInfo names its certificate by subjectKeyIdentifier, which apksig does not resolve (it matches issuerAndSerialNumber only), so apksig's v1 verification fails for this block. The certificate it names is reported as declared, and v1_signers_match_block_signers treats this signer as unknown.`,
        ]
      : []),
    ...(decoded.ok &&
    decoded.value.signerInfos.some(
      (info) => info.certificateIssue === "ambiguous-identifier",
    )
      ? [
          `${entry.block.name}: multiple distinct certificates match one SignerInfo identifier; its certificate identity is unknown and all carried certificates are retained.`,
        ]
      : []),
    ...(decoded.ok && decoded.value.trailingBytes > 0
      ? [
          `${entry.block.name}: ${String(decoded.value.trailingBytes)} bytes follow the PKCS#7 ContentInfo and were ignored, as apksig ignores them.`,
        ]
      : []),
  ]);

/**
 * The certificate the posture compares for one v1 signer: null (unknown) when
 * a SignerInfo is identified by subjectKeyIdentifier, which apksig cannot
 * resolve, so no match is claimed that apksig would reject.
 */
export const v1PostureFingerprint = (signer: V1Signer): string | null =>
  signer.signer_infos.some(
    (info) => info.identified_by === "subject-key-identifier",
  )
    ? null
    : (signer.certificate?.sha256_fingerprint ?? null);

/** Materialise one v1 signer's declared facts through the shared certificate owner. */
export const v1SignerFacts = ({
  entry,
  decoded,
}: DecodedV1Signer): V1Signer => {
  const base = {
    signature_file: entry.signatureFile,
    block_file: entry.block.name,
  };
  if (!decoded.ok)
    return {
      ...base,
      certificate: null,
      certificates: [],
      signer_infos: [],
      decode_error: decoded.error,
    };
  const facts = decoded.value.certificates.map(certificateFacts);
  const infos = decoded.value.signerInfos;
  const named = (index: number | null): Certificate =>
    index === null ? null : (facts[index] ?? null);
  return {
    ...base,
    // Without verification, a block with several SignerInfos has no one signer.
    certificate:
      infos.length === 1 ? named(infos[0]?.certificateIndex ?? null) : null,
    certificates: facts.map(({ sha256_fingerprint, subject }) => ({
      sha256_fingerprint,
      subject,
    })),
    signer_infos: infos.map((info) => ({
      identified_by: info.identifiedBy,
      certificate_sha256:
        named(info.certificateIndex)?.sha256_fingerprint ?? null,
      digest_algorithm_oid: info.digestAlgorithmOid,
      signature_algorithm_oid: info.signatureAlgorithmOid,
    })),
    decode_error: null,
  };
};
