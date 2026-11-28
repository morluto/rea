import { BinaryReader } from "../../domain/binaryContainer.js";
import {
  MACOS_PKG_FORMAT,
  MACOS_PKG_MAX_TOC_COMPRESSED_BYTES,
  MACOS_PKG_MAX_TOC_UNCOMPRESSED_BYTES,
  XAR_CHECKSUM_ALGORITHMS,
  XAR_HEADER_MAX_BYTES,
  XAR_HEADER_MIN_BYTES,
  XAR_MAGIC,
  XAR_MAGIC_TEXT,
  type MacosPkgParseError,
  type XarHeader,
} from "../../domain/macosPkgFormat.js";
import {
  decodeLimit,
  malformedInput,
  truncatedInput,
} from "../../domain/parseFailure.js";
import { err, ok, type Result } from "../../domain/result.js";

const asSafeLength = (
  value: bigint,
  field: string,
): Result<number, MacosPkgParseError> => {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER))
    return err(
      malformedInput(
        MACOS_PKG_FORMAT,
        `XAR ${field} is not an exact nonnegative extent`,
        { field },
      ),
    );
  return ok(Number(value));
};

/**
 * Parse the 28-byte xar header. Extra header bytes declared by `size` are not
 * interpreted; the TOC begins at that size. Fail-closed on a short buffer,
 * wrong magic, or a size that cannot hold this header.
 */
export const parseXarHeader = (
  header: Buffer,
): Result<XarHeader, MacosPkgParseError> => {
  if (header.length < XAR_HEADER_MIN_BYTES)
    return err(
      truncatedInput(
        MACOS_PKG_FORMAT,
        `XAR header is truncated: ${String(header.length)} bytes, expected ${String(XAR_HEADER_MIN_BYTES)}`,
        { field: "header" },
      ),
    );
  const reader = new BinaryReader(header, false, MACOS_PKG_FORMAT);
  if (reader.u32(0) !== XAR_MAGIC)
    return err(
      malformedInput(
        MACOS_PKG_FORMAT,
        `XAR magic mismatch: expected ${XAR_MAGIC_TEXT}`,
        { field: "magic" },
      ),
    );
  const headerSize = reader.u16(4);
  if (headerSize < XAR_HEADER_MIN_BYTES)
    return err(
      malformedInput(
        MACOS_PKG_FORMAT,
        `XAR header size ${String(headerSize)} is smaller than ${String(XAR_HEADER_MIN_BYTES)} bytes`,
        { field: "size" },
      ),
    );
  if (headerSize > XAR_HEADER_MAX_BYTES)
    return err(
      malformedInput(
        MACOS_PKG_FORMAT,
        `XAR header size ${String(headerSize)} exceeds the ${String(XAR_HEADER_MAX_BYTES)}-byte allowance`,
        { field: "size" },
      ),
    );
  const tocCompressed = asSafeLength(
    reader.word(8, 64),
    "toc_length_compressed",
  );
  if (!tocCompressed.ok) return tocCompressed;
  const tocUncompressed = asSafeLength(
    reader.word(16, 64),
    "toc_length_uncompressed",
  );
  if (!tocUncompressed.ok) return tocUncompressed;
  if (tocCompressed.value > MACOS_PKG_MAX_TOC_COMPRESSED_BYTES)
    return err(
      decodeLimit(
        MACOS_PKG_FORMAT,
        `XAR compressed TOC is ${String(tocCompressed.value)} bytes, above the ${String(MACOS_PKG_MAX_TOC_COMPRESSED_BYTES)}-byte allowance`,
        {
          name: "macos_pkg_toc_compressed_bytes",
          maximum: MACOS_PKG_MAX_TOC_COMPRESSED_BYTES,
          required: tocCompressed.value,
        },
        { field: "toc_length_compressed" },
      ),
    );
  if (tocUncompressed.value > MACOS_PKG_MAX_TOC_UNCOMPRESSED_BYTES)
    return err(
      decodeLimit(
        MACOS_PKG_FORMAT,
        `XAR uncompressed TOC is ${String(tocUncompressed.value)} bytes, above the ${String(MACOS_PKG_MAX_TOC_UNCOMPRESSED_BYTES)}-byte allowance`,
        {
          name: "macos_pkg_toc_uncompressed_bytes",
          maximum: MACOS_PKG_MAX_TOC_UNCOMPRESSED_BYTES,
          required: tocUncompressed.value,
        },
        { field: "toc_length_uncompressed" },
      ),
    );
  const checksumAlgorithmId = reader.u32(24);
  return ok({
    magic: XAR_MAGIC,
    headerSize,
    version: reader.u16(6),
    tocCompressedLength: tocCompressed.value,
    tocUncompressedLength: tocUncompressed.value,
    checksumAlgorithmId,
    checksumAlgorithm:
      XAR_CHECKSUM_ALGORITHMS[checksumAlgorithmId] ?? "unknown",
    heapOffset: headerSize + tocCompressed.value,
  });
};
