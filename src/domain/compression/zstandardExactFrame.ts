import { constants as bufferConstants } from "node:buffer";
import { constants, zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { nodeCodecResult } from "../../kernel/nodeCodecResult.js";
import { hostRangeErrorKind } from "../parseFailure.js";
import {
  currentZstandardFrameAllowance,
  type ZstandardFrameAllowance,
  type ZstandardFrameSource,
  zstandardWorkLimitFacts,
} from "./zstandardFrameAllowance.js";

/** Zstandard's default maximum decoder window, 2^27 bytes (128 MiB). */
export const ZSTANDARD_WINDOW_LOG_MAX = 27;

const ZSTD_MAGIC = 0xfd2fb528;
const SKIPPABLE_MAGIC_MIN = 0x184d2a50;
const SKIPPABLE_MAGIC_MAX = 0x184d2a5f;

/**
 * Structural framing failures. `work_limit` is a decoder-work refusal, not
 * evidence that the bytes are malformed.
 */
export const ZSTANDARD_FRAME_REASONS = [
  "truncated_frame_header",
  "truncated_block",
  "truncated_checksum",
  "trailing_bytes",
  "work_limit",
  "malformed",
  "output_limit",
] as const;

export type ZstandardFrameReason = (typeof ZSTANDARD_FRAME_REASONS)[number];

export type ZstandardFrameMode = "exact" | "prefix";

export interface ZstandardDecodeOptions {
  /** Aggregate decoded-output ceiling. Node applies it to one decoder call. */
  readonly maxOutputLength?: number;
  /** `ZSTD_d_windowLogMax`. The default is Zstandard's 128 MiB window. */
  readonly windowLogMax?: number;
  /** Optional dictionary. Frames that name a dictionary fail without one. */
  readonly dictionary?: Uint8Array;
  /**
   * `exact` rejects every byte that is not part of a complete frame.
   * `prefix` returns the decoded frames and the byte count they occupied,
   * leaving a non-frame suffix unconsumed.
   */
  readonly mode?: ZstandardFrameMode;
  /** When omitted, the accepted operation's `zstd.max_frames` allowance. */
  readonly allowance?: ZstandardFrameAllowance;
}

export interface ZstandardFrameFailure {
  readonly ok: false;
  readonly reason: ZstandardFrameReason;
  readonly offset: number;
  /** Node or structural code for a malformed frame. Absent for truncation. */
  readonly code?: string;
  /** Decoder text for a malformed frame. Callers may keep it; tests use `code`. */
  readonly detail?: string;
  readonly setting?: "zstd.max_frames";
  readonly value?: number;
  readonly source?: ZstandardFrameSource;
  readonly minimum?: number;
  readonly maximum?: number;
}

export interface ZstandardFrameSuccess {
  readonly ok: true;
  readonly bytes: Buffer;
  readonly consumedBytes: number;
  readonly frames: number;
}

export type ZstandardFrameResult =
  | ZstandardFrameSuccess
  | ZstandardFrameFailure;

interface FrameSpan {
  readonly offset: number;
  readonly length: number;
  readonly kind: "zstd" | "skippable";
}

interface WalkSuccess {
  readonly ok: true;
  readonly frames: readonly FrameSpan[];
  readonly consumed: number;
}

const failure = (
  reason: ZstandardFrameReason,
  offset: number,
  code?: string,
  detail?: string,
): ZstandardFrameFailure => ({
  ok: false,
  reason,
  offset,
  ...(code === undefined ? {} : { code }),
  ...(detail === undefined ? {} : { detail }),
});

const workLimit = (
  allowance: ZstandardFrameAllowance,
  offset: number,
): ZstandardFrameFailure => ({
  ok: false,
  offset,
  ...zstandardWorkLimitFacts(allowance),
});

const u24 = (bytes: Uint8Array, offset: number): number =>
  (bytes[offset] ?? 0) |
  ((bytes[offset + 1] ?? 0) << 8) |
  ((bytes[offset + 2] ?? 0) << 16);

const u32 = (bytes: Uint8Array, offset: number): number =>
  (u24(bytes, offset) | ((bytes[offset + 3] ?? 0) << 24)) >>> 0;

const isSkippableMagic = (magic: number): boolean =>
  magic >= SKIPPABLE_MAGIC_MIN && magic <= SKIPPABLE_MAGIC_MAX;

const hasMagic = (bytes: Uint8Array, offset: number): boolean => {
  if (offset + 4 > bytes.length) return false;
  const magic = u32(bytes, offset);
  return magic === ZSTD_MAGIC || isSkippableMagic(magic);
};

/**
 * One Zstandard frame after its magic, per RFC 8878 §3.1.1. The walk uses
 * header and block sizes only; it does not interpret compressed blocks.
 */
const zstdFrameLength = (
  bytes: Uint8Array,
  offset: number,
): { readonly length: number } | ZstandardFrameFailure => {
  if (offset + 5 > bytes.length)
    return failure("truncated_frame_header", offset);
  const descriptor = bytes[offset + 4] ?? 0;
  const dictionaryFlag = descriptor & 0x3;
  const checksum = (descriptor >>> 2) & 0x1;
  const reserved = (descriptor >>> 3) & 0x1;
  const singleSegment = (descriptor >>> 5) & 0x1;
  const contentSizeFlag = (descriptor >>> 6) & 0x3;
  // RFC 8878 requires the reserved bit to be zero. The unused bit is not
  // interpreted by a decoder of this specification version.
  if (reserved !== 0)
    return failure("malformed", offset, "reserved_frame_descriptor");
  const dictionaryBytes =
    dictionaryFlag === 0 ? 0 : dictionaryFlag === 3 ? 4 : dictionaryFlag;
  const contentSizeBytes =
    contentSizeFlag === 0
      ? singleSegment === 1
        ? 1
        : 0
      : contentSizeFlag === 1
        ? 2
        : contentSizeFlag === 2
          ? 4
          : 8;
  const headerBytes =
    5 + (singleSegment === 1 ? 0 : 1) + dictionaryBytes + contentSizeBytes;
  if (offset + headerBytes > bytes.length)
    return failure("truncated_frame_header", offset);
  let cursor = offset + headerBytes;
  for (;;) {
    if (cursor + 3 > bytes.length) return failure("truncated_block", cursor);
    const header = u24(bytes, cursor);
    const last = header & 0x1;
    const type = (header >>> 1) & 0x3;
    const size = header >>> 3;
    cursor += 3;
    if (type === 3) return failure("malformed", cursor - 3, "reserved_block");
    // An RLE block stores one byte and repeats it `size` times.
    const contentBytes = type === 1 ? 1 : size;
    if (cursor + contentBytes > bytes.length)
      return failure("truncated_block", cursor);
    cursor += contentBytes;
    if (last === 1) break;
  }
  if (checksum === 1) {
    if (cursor + 4 > bytes.length) return failure("truncated_checksum", cursor);
    cursor += 4;
  }
  return { length: cursor - offset };
};

const skippableFrameLength = (
  bytes: Uint8Array,
  offset: number,
): { readonly length: number } | ZstandardFrameFailure => {
  if (offset + 8 > bytes.length)
    return failure("truncated_frame_header", offset);
  const userBytes = u32(bytes, offset + 4);
  if (offset + 8 + userBytes > bytes.length)
    return failure("truncated_block", offset + 8);
  return { length: 8 + userBytes };
};

const frameAt = (
  bytes: Uint8Array,
  offset: number,
):
  | { readonly span: FrameSpan }
  | { readonly stop: true }
  | ZstandardFrameFailure => {
  if (!hasMagic(bytes, offset)) return { stop: true };
  const magic = u32(bytes, offset);
  const parsed =
    magic === ZSTD_MAGIC
      ? zstdFrameLength(bytes, offset)
      : skippableFrameLength(bytes, offset);
  if ("ok" in parsed) return parsed;
  return {
    span: {
      offset,
      length: parsed.length,
      kind: magic === ZSTD_MAGIC ? "zstd" : "skippable",
    },
  };
};

/**
 * Exact frame boundaries for one buffer. The walk does not ask the decoder
 * how many bytes it consumed.
 */
const walkFrames = (
  bytes: Uint8Array,
  allowance: ZstandardFrameAllowance,
  mode: ZstandardFrameMode,
): WalkSuccess | ZstandardFrameFailure => {
  const frames: FrameSpan[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (frames.length === allowance.maxFrames) {
      if (hasMagic(bytes, offset)) return workLimit(allowance, offset);
      if (mode === "exact") return failure("trailing_bytes", offset);
      break;
    }
    if (offset + 4 > bytes.length) {
      if (frames.length === 0) return failure("truncated_frame_header", offset);
      if (mode === "exact") return failure("trailing_bytes", offset);
      break;
    }
    const next = frameAt(bytes, offset);
    if ("stop" in next) {
      if (frames.length === 0) return failure("malformed", offset, "magic");
      if (mode === "exact") return failure("trailing_bytes", offset);
      break;
    }
    if ("ok" in next) return next;
    frames.push(next.span);
    offset += next.span.length;
  }
  if (frames.length === 0) return failure("truncated_frame_header", 0);
  return { ok: true, frames, consumed: offset };
};

const decoderCode = (cause: unknown): string | undefined => {
  if (typeof cause !== "object" || cause === null || !("code" in cause))
    return undefined;
  const code = cause.code;
  return typeof code === "string" ? code : undefined;
};

const decoderFailure = (
  cause: unknown,
  offset: number,
): ZstandardFrameFailure => {
  if (hostRangeErrorKind(cause) === "host-capacity")
    return failure("output_limit", offset);
  const code = decoderCode(cause);
  const detail = cause instanceof Error ? cause.message : undefined;
  if (code === "ZSTD_error_dstSize_tooSmall" || code === "ERR_BUFFER_TOO_LARGE")
    return failure("output_limit", offset, code, detail);
  return failure("malformed", offset, code, detail);
};

const isFrameFailure = (
  value: { readonly bytes: Buffer } | ZstandardFrameFailure,
): value is ZstandardFrameFailure => "reason" in value;

interface DecompressOptions {
  readonly maxOutputLength: number;
  readonly windowLogMax: number;
  readonly dictionary?: Uint8Array;
  readonly rejectTrailing: boolean;
}

/**
 * Node 22 stops after the first frame and ignores `rejectGarbageAfterEnd`.
 * Node 24.19+ and Node 26 decode a whole sequence and reject a suffix with
 * that option. Probe once; do not trust a major-version check alone.
 */
let strictSequence: boolean | undefined;
const nodeDecodesStrictSequence = (): boolean => {
  if (strictSequence !== undefined) return strictSequence;
  const frame = zstdCompressSync(Buffer.from([0x61]));
  const pair = Buffer.concat([frame, frame]);
  let concatenated = false;
  try {
    concatenated = zstdDecompressSync(pair).length === 2;
  } catch {
    concatenated = false;
  }
  let strict = false;
  if (concatenated) {
    try {
      zstdDecompressSync(Buffer.concat([frame, Buffer.of(0)]), {
        rejectGarbageAfterEnd: true,
      });
    } catch {
      strict = true;
    }
  }
  strictSequence = strict;
  return strictSequence;
};

const decompress = (
  input: Uint8Array,
  offset: number,
  options: DecompressOptions,
): { readonly bytes: Buffer } | ZstandardFrameFailure => {
  try {
    const result = nodeCodecResult(
      zstdDecompressSync(input, {
        info: true,
        maxOutputLength: Math.max(1, options.maxOutputLength),
        ...(options.rejectTrailing ? { rejectGarbageAfterEnd: true } : {}),
        ...(options.dictionary === undefined
          ? {}
          : { dictionary: options.dictionary }),
        params: { [constants.ZSTD_d_windowLogMax]: options.windowLogMax },
      }),
    );
    // The walk already fixed the input extent. A short read means the
    // decoder did not accept that extent, so the bytes are not returned.
    if (result.consumedBytes !== input.length)
      return failure("malformed", offset, "unconsumed_input");
    return { bytes: result.buffer };
  } catch (cause: unknown) {
    return decoderFailure(cause, offset);
  }
};

/**
 * Node's synchronous decoder returns a view onto a larger chunk allocation.
 * Retaining that view keeps the whole chunk. One byte from a 16 KiB chunk,
 * repeated for every frame, retains mebibytes for a few kibibytes of output.
 * Copy only when the backing store is larger than the bytes in use.
 */
export const ownedZstandardBytes = (bytes: Buffer): Buffer => {
  if (bytes.byteOffset === 0 && bytes.buffer.byteLength === bytes.byteLength)
    return bytes;
  const owned = Buffer.allocUnsafe(bytes.byteLength);
  bytes.copy(owned);
  return owned;
};

const withinOutput = (
  bytes: Buffer,
  remaining: number,
  offset: number,
): { readonly bytes: Buffer } | ZstandardFrameFailure =>
  bytes.length > remaining ? failure("output_limit", offset) : { bytes };

const decodeFrames = (
  bytes: Uint8Array,
  frames: readonly FrameSpan[],
  consumed: number,
  options: DecompressOptions,
): ZstandardFrameSuccess | ZstandardFrameFailure => {
  if (options.rejectTrailing) {
    const decoded = decompress(bytes.subarray(0, consumed), 0, options);
    if (isFrameFailure(decoded)) return decoded;
    const bounded = withinOutput(decoded.bytes, options.maxOutputLength, 0);
    if (isFrameFailure(bounded)) return bounded;
    return {
      ok: true,
      bytes: ownedZstandardBytes(bounded.bytes),
      consumedBytes: consumed,
      frames: frames.length,
    };
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for (const frame of frames) {
    if (frame.kind === "skippable") continue;
    const remaining = options.maxOutputLength - total;
    const decoded = decompress(
      bytes.subarray(frame.offset, frame.offset + frame.length),
      frame.offset,
      { ...options, maxOutputLength: Math.max(1, remaining) },
    );
    if (isFrameFailure(decoded)) return decoded;
    const bounded = withinOutput(decoded.bytes, remaining, frame.offset);
    if (isFrameFailure(bounded)) return bounded;
    total += bounded.bytes.length;
    chunks.push(ownedZstandardBytes(bounded.bytes));
  }
  return {
    ok: true,
    bytes: chunks.length === 0 ? Buffer.alloc(0) : Buffer.concat(chunks),
    consumedBytes: consumed,
    frames: frames.length,
  };
};

/**
 * Decode one Zstandard buffer. Frame boundaries come from the structural
 * walk. Where Node's public strict decoder accepts a whole sequence, one
 * call decodes that sequence and checks its checksums. Otherwise each
 * walked frame is decoded on its own, which is what Node 22 requires.
 */
export const decodeZstandardFrames = (
  bytes: Uint8Array,
  options: ZstandardDecodeOptions = {},
): ZstandardFrameResult => {
  const allowance = options.allowance ?? currentZstandardFrameAllowance();
  const mode = options.mode ?? "exact";
  const walked = walkFrames(bytes, allowance, mode);
  if ("reason" in walked) return walked;
  const maxOutputLength = options.maxOutputLength ?? bufferConstants.MAX_LENGTH;
  return decodeFrames(bytes, walked.frames, walked.consumed, {
    maxOutputLength,
    windowLogMax: options.windowLogMax ?? ZSTANDARD_WINDOW_LOG_MAX,
    ...(options.dictionary === undefined
      ? {}
      : { dictionary: options.dictionary }),
    rejectTrailing: nodeDecodesStrictSequence(),
  });
};
