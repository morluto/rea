import { constants, inflateSync, zstdDecompressSync } from "node:zlib";

const SHF_COMPRESSED = 0x800n;
const ELFCOMPRESS_ZLIB = 1;
const ELFCOMPRESS_ZSTD = 2;

export type ElfCompressedSectionResult =
  | {
      readonly state: "available";
      readonly bytes: Buffer;
      readonly compressed: boolean;
      readonly compression: "none" | "zlib" | "zstd";
    }
  | { readonly state: "unsupported"; readonly compressionType: number }
  | { readonly state: "malformed"; readonly message: string }
  | {
      readonly state: "limit";
      readonly requiredBytes: bigint;
      readonly maximumBytes: number;
    };

/**
 * Decode one ELF section payload. `subject` is the noun phrase used in
 * failure text so existing section-name messages stay stable.
 */
export const decodeElfCompressedSection = (
  bytes: Buffer,
  flags: bigint,
  bits: 32 | 64,
  little: boolean,
  maximumDecodedBytes: number,
  subject: string,
): ElfCompressedSectionResult => {
  if ((flags & SHF_COMPRESSED) === 0n)
    return {
      state: "available",
      bytes,
      compressed: false,
      compression: "none",
    };

  const headerBytes = bits === 64 ? 24 : 12;
  if (bytes.length < headerBytes)
    return { state: "malformed", message: `${subject} header is truncated` };
  const compressionType = little
    ? bytes.readUInt32LE(0)
    : bytes.readUInt32BE(0);
  if (
    compressionType !== ELFCOMPRESS_ZLIB &&
    compressionType !== ELFCOMPRESS_ZSTD
  )
    return { state: "unsupported", compressionType };

  const declaredSize =
    bits === 64
      ? little
        ? bytes.readBigUInt64LE(8)
        : bytes.readBigUInt64BE(8)
      : BigInt(little ? bytes.readUInt32LE(4) : bytes.readUInt32BE(4));
  if (declaredSize > BigInt(maximumDecodedBytes))
    return {
      state: "limit",
      requiredBytes: declaredSize,
      maximumBytes: maximumDecodedBytes,
    };
  return inflateDeclared(
    bytes.subarray(headerBytes),
    declaredSize,
    compressionType === ELFCOMPRESS_ZSTD ? "zstd" : "zlib",
    subject,
  );
};

/**
 * Decode a legacy GNU `.zdebug_*` payload: `ZLIB`, an 8-byte big-endian
 * uncompressed size, then a zlib stream. The declared size is admitted
 * before inflation.
 */
export const decodeElfGnuZlibSection = (
  bytes: Buffer,
  maximumDecodedBytes: number,
  subject: string,
): ElfCompressedSectionResult => {
  if (bytes.length < 12 || bytes.subarray(0, 4).toString("latin1") !== "ZLIB")
    return {
      state: "malformed",
      message: `${subject} is not a GNU ZLIB compressed section`,
    };
  const declaredSize = bytes.readBigUInt64BE(4);
  if (declaredSize > BigInt(maximumDecodedBytes))
    return {
      state: "limit",
      requiredBytes: declaredSize,
      maximumBytes: maximumDecodedBytes,
    };
  return inflateDeclared(bytes.subarray(12), declaredSize, "zlib", subject);
};

const inflateDeclared = (
  payload: Buffer,
  declaredSize: bigint,
  compression: "zlib" | "zstd",
  subject: string,
): ElfCompressedSectionResult => {
  const expected = Number(declaredSize);
  let decoded: Buffer;
  try {
    const maxOutputLength = Math.max(1, expected);
    decoded =
      compression === "zstd"
        ? zstdDecompressSync(payload, {
            maxOutputLength,
            // Retain Zstandard's default maximum decoder window of 128 MiB.
            params: { [constants.ZSTD_d_windowLogMax]: 27 },
          })
        : inflateSync(payload, { maxOutputLength });
  } catch (cause: unknown) {
    return {
      state: "malformed",
      message: `${subject} could not be decompressed: ${cause instanceof Error ? cause.message : "invalid compressed data"}`,
    };
  }
  if (decoded.length !== expected)
    return {
      state: "malformed",
      message: `${subject} size is inconsistent`,
    };
  return { state: "available", bytes: decoded, compressed: true, compression };
};
