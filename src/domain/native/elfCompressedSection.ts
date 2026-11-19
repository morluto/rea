import { BinaryReader } from "../binaryContainer.js";
import { inflateSync } from "node:zlib";
import { nodeCodecResult } from "../../kernel/nodeCodecResult.js";
import {
  decodeZstandardFrames,
  ZSTANDARD_WINDOW_LOG_MAX,
  type ZstandardFrameFailure,
} from "../compression/zstandardExactFrame.js";
import {
  zstandardWorkLimitFacts,
  type ZstandardFrameSource,
} from "../compression/zstandardFrameAllowance.js";
import type { ConfigurationError } from "../configurationErrors.js";

const SHF_COMPRESSED = 0x800n;
const ELFCOMPRESS_ZLIB = 1;
const ELFCOMPRESS_ZSTD = 2;

export type ElfCompressedSectionResult =
  | {
      readonly state: "available";
      readonly bytes: Buffer;
      readonly compressed: boolean;
      readonly compression: "none" | "zlib" | "zstd";
      /** Larger of decoded output and compressed input read; 0 when stored. */
      readonly inflatedBytes: number;
    }
  | { readonly state: "unsupported"; readonly compressionType: number }
  | {
      readonly state: "malformed";
      readonly message: string;
      /** Larger of declared output and compressed input read; 0 when no attempt started. */
      readonly inflatedBytes: number;
      /** Present when the shared Zstandard framer classified the payload. */
      readonly reason?: ZstandardFrameFailure["reason"];
      readonly offset?: number;
      readonly code?: string;
    }
  | {
      readonly state: "configuration";
      readonly error: ConfigurationError;
      readonly inflatedBytes: number;
    }
  | {
      readonly state: "work_limit";
      readonly reason: "work_limit";
      readonly setting: "zstd.max_frames";
      readonly value: number;
      readonly source: ZstandardFrameSource;
      readonly minimum: number;
      readonly maximum: number;
      readonly offset: number;
      /** Larger of declared output and compressed input read. */
      readonly inflatedBytes: number;
    }
  | {
      readonly state: "limit";
      readonly requiredBytes: bigint;
      readonly maximumBytes: number;
    };

/** Compression framing, read without inflating or allocating the declared output. */
export type ElfCompressedSectionHeader =
  | { readonly state: "uncompressed" }
  | {
      readonly state: "compressed";
      readonly compressionType:
        | typeof ELFCOMPRESS_ZLIB
        | typeof ELFCOMPRESS_ZSTD;
      readonly declaredSize: bigint;
      readonly headerBytes: number;
    }
  | { readonly state: "unsupported"; readonly compressionType: number }
  | { readonly state: "malformed"; readonly message: string };

/** The decoder and preflight admission use the same accepted framing. */
export const readElfCompressedSectionHeader = (
  bytes: Buffer,
  flags: bigint,
  bits: 32 | 64,
  little: boolean,
  subject: string,
): ElfCompressedSectionHeader => {
  if ((flags & SHF_COMPRESSED) === 0n) return { state: "uncompressed" };
  const headerBytes = bits === 64 ? 24 : 12;
  if (bytes.length < headerBytes)
    return { state: "malformed", message: `${subject} header is truncated` };
  const reader = new BinaryReader(bytes, little, "elf");
  const compressionType = reader.u32(0);
  if (
    compressionType !== ELFCOMPRESS_ZLIB &&
    compressionType !== ELFCOMPRESS_ZSTD
  )
    return { state: "unsupported", compressionType };
  const declaredSize = reader.word(bits === 64 ? 8 : 4, bits);
  const alignment = reader.word(bits === 64 ? 16 : 8, bits);
  if ((alignment & (alignment - 1n)) !== 0n)
    return {
      state: "malformed",
      message: `${subject} has an invalid decoded alignment`,
    };
  return { state: "compressed", compressionType, declaredSize, headerBytes };
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
  const header = readElfCompressedSectionHeader(
    bytes,
    flags,
    bits,
    little,
    subject,
  );
  if (header.state === "uncompressed")
    return {
      state: "available",
      bytes,
      compressed: false,
      compression: "none",
      inflatedBytes: 0,
    };
  if (header.state === "malformed") return { ...header, inflatedBytes: 0 };
  if (header.state === "unsupported") return header;
  const { compressionType, declaredSize, headerBytes } = header;
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
      inflatedBytes: 0,
    };
  const declaredSize = new BinaryReader(bytes, false, "elf").word(4, 64);
  if (declaredSize > BigInt(maximumDecodedBytes))
    return {
      state: "limit",
      requiredBytes: declaredSize,
      maximumBytes: maximumDecodedBytes,
    };
  return inflateDeclared(bytes.subarray(12), declaredSize, "zlib", subject);
};

const zstdSectionFailure = (
  result: ZstandardFrameFailure,
  subject: string,
  inflatedBytes: number,
): ElfCompressedSectionResult => {
  if (result.reason === "invalid_allowance" && result.configuration)
    return {
      state: "configuration",
      error: result.configuration,
      inflatedBytes,
    };
  if (result.reason === "work_limit")
    return {
      state: "work_limit",
      ...zstandardWorkLimitFacts({
        maxFrames: result.value ?? 0,
        source: result.source ?? "default",
      }),
      offset: result.offset,
      inflatedBytes,
    };
  if (result.reason === "output_limit")
    return {
      state: "malformed",
      reason: "output_limit",
      offset: result.offset,
      message: `${subject} size is inconsistent`,
      inflatedBytes,
    };
  return {
    state: "malformed",
    reason: result.reason,
    offset: result.offset,
    ...(result.code === undefined ? {} : { code: result.code }),
    message: `${subject} could not be decompressed: ${result.detail ?? result.code ?? result.reason}`,
    inflatedBytes,
  };
};

const inflateDeclared = (
  payload: Buffer,
  declaredSize: bigint,
  compression: "zlib" | "zstd",
  subject: string,
): ElfCompressedSectionResult => {
  const expected = Number(declaredSize);
  const inflatedBytes = Math.max(expected, payload.length);
  let decoded: Buffer;
  try {
    const maxOutputLength = Math.max(1, expected);
    if (compression === "zstd") {
      const result = decodeZstandardFrames(payload, {
        maxOutputLength,
        // Retain Zstandard's default maximum decoder window of 128 MiB.
        windowLogMax: ZSTANDARD_WINDOW_LOG_MAX,
      });
      if (!result.ok) return zstdSectionFailure(result, subject, inflatedBytes);
      decoded = result.bytes;
    } else {
      const result = nodeCodecResult(
        inflateSync(payload, { info: true, maxOutputLength }),
      );
      if (result.consumedBytes !== payload.length)
        return {
          state: "malformed",
          message: `${subject} has bytes after its zlib stream`,
          inflatedBytes,
        };
      decoded = result.buffer;
    }
  } catch (cause: unknown) {
    return {
      state: "malformed",
      inflatedBytes,
      message: `${subject} could not be decompressed: ${cause instanceof Error ? cause.message : "invalid compressed data"}`,
    };
  }
  if (decoded.length !== expected)
    return {
      state: "malformed",
      message: `${subject} size is inconsistent`,
      inflatedBytes,
    };
  return {
    state: "available",
    bytes: decoded,
    compressed: true,
    compression,
    inflatedBytes,
  };
};
