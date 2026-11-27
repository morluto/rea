import { reportedSystemCode } from "../../kernel/reportedSystemCode.js";
import { constants as bufferConstants } from "node:buffer";
import { promisify } from "node:util";
import {
  constants,
  zstdCompressSync,
  zstdDecompress,
  zstdDecompressSync,
} from "node:zlib";
import { nodeCodecResult } from "../../kernel/nodeCodecResult.js";
import { hostRangeErrorKind } from "../parseFailure.js";
import type { ConfigurationError } from "../configurationErrors.js";
import {
  currentZstandardFrameAllowance,
  type ZstandardFrameAllowance,
  type ZstandardFrameSource,
  zstandardWorkLimitFacts,
} from "./zstandardFrameAllowance.js";
import {
  ZSTANDARD_MAGIC_BYTES,
  ZSTANDARD_TRUNCATION_REASONS,
  zstandardFrameMagicStatus,
  zstandardFrameReads,
  type ZstandardFrameKind,
  type ZstandardTruncationReason,
} from "./zstandardFrameWire.js";

/** Zstandard's default maximum decoder window, 2^27 bytes (128 MiB). */
export const ZSTANDARD_WINDOW_LOG_MAX = 27;

/**
 * Structural framing failures. `work_limit` is a decoder-work refusal, not
 * evidence that the bytes are malformed.
 */
export const ZSTANDARD_FRAME_REASONS = [
  ...ZSTANDARD_TRUNCATION_REASONS,
  "trailing_bytes",
  "work_limit",
  "malformed",
  "output_limit",
  "invalid_allowance",
] as const;

export type ZstandardFrameReason = (typeof ZSTANDARD_FRAME_REASONS)[number];

const ZSTANDARD_TRUNCATION_REASON_SET: ReadonlySet<ZstandardFrameReason> =
  new Set(ZSTANDARD_TRUNCATION_REASONS);

/** True when framing ended before the end of the Zstandard frame rather than on corrupt bytes. */
export const isZstandardTruncationReason = (
  reason: ZstandardFrameReason,
): reason is ZstandardTruncationReason =>
  ZSTANDARD_TRUNCATION_REASON_SET.has(reason);

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
  /** Present when the launch seed for `zstd.max_frames` cannot be parsed. */
  readonly configuration?: ConfigurationError;
}

export interface ZstandardFrameSuccess {
  readonly ok: true;
  readonly bytes: Buffer;
  readonly consumedBytes: number;
  readonly frames: number;
  /**
   * True when the walk stopped because the supplied input ended at a frame
   * boundary or inside a 1-3 byte prefix of a possible next Zstandard/skippable
   * frame magic, rather than on definite non-frame trailing bytes.
   */
  readonly inputExhausted: boolean;
  /**
   * Present when `inputExhausted` is true and the walk already admitted
   * `allowance.maxFrames` frames, so any following Zstandard/skippable frame
   * would exceed `zstd.max_frames`.
   */
  readonly frameAllowanceReached?: ZstandardFrameAllowance;
}

export type ZstandardFrameResult =
  | ZstandardFrameSuccess
  | ZstandardFrameFailure;

interface FrameSpan {
  readonly offset: number;
  readonly length: number;
  readonly kind: ZstandardFrameKind;
}

interface WalkSuccess {
  readonly ok: true;
  readonly frames: readonly FrameSpan[];
  readonly consumed: number;
  readonly inputExhausted: boolean;
  readonly frameAllowanceReached?: ZstandardFrameAllowance;
}

// Bound structural work between cooperative pauses, including across frames.
const READS_PER_PAUSE = 64;
interface FrameWalkProgress {
  reads: number;
}
const needsFrameWalkPause = (progress: FrameWalkProgress): boolean =>
  ++progress.reads % READS_PER_PAUSE === 0;

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

const unreadBytes = new Uint8Array(0);

function* frameAt(
  bytes: Uint8Array,
  offset: number,
  kind: ZstandardFrameKind,
  progress: FrameWalkProgress,
): Generator<void, FrameSpan | ZstandardFrameFailure> {
  let cursor = offset + ZSTANDARD_MAGIC_BYTES;
  const reads = zstandardFrameReads(kind, offset);
  let step = reads.next();
  while (!step.done) {
    if (needsFrameWalkPause(progress)) yield;
    const read = step.value;
    const end = cursor + read.length;
    if (end > bytes.length) return failure(read.eof, read.failureOffset);
    step = reads.next(read.inspect ? bytes.subarray(cursor, end) : unreadBytes);
    cursor = end;
  }
  if (step.value !== undefined)
    return failure("malformed", step.value.offset, step.value.code);
  return { offset, length: cursor - offset, kind };
}

/**
 * Exact frame boundaries for one buffer. The walk does not ask the decoder
 * how many bytes it consumed.
 */
function* walkFrames(
  bytes: Uint8Array,
  allowance: ZstandardFrameAllowance,
  mode: ZstandardFrameMode,
): Generator<void, WalkSuccess | ZstandardFrameFailure> {
  const frames: FrameSpan[] = [];
  const progress = { reads: 0 };
  let offset = 0;
  let inputExhausted = false;
  while (offset < bytes.length) {
    const status = zstandardFrameMagicStatus(bytes, offset);
    if (frames.length === allowance.maxFrames) {
      if (status === "zstd" || status === "skippable")
        return workLimit(allowance, offset);
      if (mode === "exact") return failure("trailing_bytes", offset);
      inputExhausted = status === "incomplete";
      break;
    }
    if (status === "incomplete") {
      if (frames.length === 0) return failure("truncated_frame_header", offset);
      if (mode === "exact") return failure("trailing_bytes", offset);
      inputExhausted = true;
      break;
    }
    if (status === "none") {
      if (frames.length === 0) {
        if (offset + ZSTANDARD_MAGIC_BYTES > bytes.length)
          return failure("truncated_frame_header", offset);
        return failure("malformed", offset, "magic");
      }
      if (mode === "exact") return failure("trailing_bytes", offset);
      break;
    }
    const next = yield* frameAt(bytes, offset, status, progress);
    if ("ok" in next) return next;
    frames.push(next);
    offset += next.length;
  }
  if (frames.length === 0) return failure("truncated_frame_header", 0);
  if (offset === bytes.length) inputExhausted = true;
  const frameAllowanceReached =
    inputExhausted && frames.length === allowance.maxFrames
      ? allowance
      : undefined;
  return {
    ok: true,
    frames,
    consumed: offset,
    inputExhausted,
    ...(frameAllowanceReached === undefined ? {} : { frameAllowanceReached }),
  };
}

const decoderFailure = (
  cause: unknown,
  offset: number,
): ZstandardFrameFailure => {
  if (hostRangeErrorKind(cause) === "host-capacity")
    return failure("output_limit", offset);
  const code = reportedSystemCode(cause);
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

const unzstd = promisify(zstdDecompress);

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

/** Async strict decode so a large sequence does not block the event loop. */
const decompressSequence = async (
  input: Uint8Array,
  offset: number,
  options: DecompressOptions,
): Promise<{ readonly bytes: Buffer } | ZstandardFrameFailure> => {
  try {
    const result = nodeCodecResult(
      await unzstd(input, {
        info: true,
        rejectGarbageAfterEnd: true,
        maxOutputLength: Math.max(1, options.maxOutputLength),
        ...(options.dictionary === undefined
          ? {}
          : { dictionary: options.dictionary }),
        params: { [constants.ZSTD_d_windowLogMax]: options.windowLogMax },
      }),
    );
    if (result.consumedBytes !== input.length)
      return failure("malformed", offset, "unconsumed_input");
    return { bytes: ownedZstandardBytes(result.buffer) };
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

const decodeDataFrame = (
  bytes: Uint8Array,
  frame: FrameSpan,
  total: number,
  options: DecompressOptions,
): { readonly bytes: Buffer } | ZstandardFrameFailure => {
  const remaining = options.maxOutputLength - total;
  const decoded = decompress(
    bytes.subarray(frame.offset, frame.offset + frame.length),
    frame.offset,
    { ...options, maxOutputLength: Math.max(1, remaining) },
  );
  if (isFrameFailure(decoded)) return decoded;
  const bounded = withinOutput(decoded.bytes, remaining, frame.offset);
  if (isFrameFailure(bounded)) return bounded;
  return { bytes: ownedZstandardBytes(bounded.bytes) };
};

const finishFrames = (
  chunks: readonly Buffer[],
  consumed: number,
  frames: number,
  inputExhausted: boolean,
  frameAllowanceReached?: ZstandardFrameAllowance,
): ZstandardFrameSuccess => {
  const only = chunks.length === 1 ? chunks[0] : undefined;
  return {
    ok: true,
    bytes:
      only !== undefined
        ? only
        : chunks.length === 0
          ? Buffer.alloc(0)
          : Buffer.concat(chunks),
    consumedBytes: consumed,
    frames,
    inputExhausted,
    ...(frameAllowanceReached === undefined ? {} : { frameAllowanceReached }),
  };
};

const decodeFrames = (
  bytes: Uint8Array,
  frames: readonly FrameSpan[],
  consumed: number,
  inputExhausted: boolean,
  frameAllowanceReached: ZstandardFrameAllowance | undefined,
  options: DecompressOptions,
): ZstandardFrameSuccess | ZstandardFrameFailure => {
  if (options.rejectTrailing) {
    const decoded = decompress(bytes.subarray(0, consumed), 0, options);
    if (isFrameFailure(decoded)) return decoded;
    const bounded = withinOutput(decoded.bytes, options.maxOutputLength, 0);
    if (isFrameFailure(bounded)) return bounded;
    return {
      ...finishFrames(
        [ownedZstandardBytes(bounded.bytes)],
        consumed,
        frames.length,
        inputExhausted,
        frameAllowanceReached,
      ),
    };
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for (const frame of frames) {
    if (frame.kind === "skippable") continue;
    const step = decodeDataFrame(bytes, frame, total, options);
    if (isFrameFailure(step)) return step;
    total += step.bytes.length;
    chunks.push(step.bytes);
  }
  return finishFrames(
    chunks,
    consumed,
    frames.length,
    inputExhausted,
    frameAllowanceReached,
  );
};

/**
 * Decode one Zstandard buffer. Frame boundaries come from the structural
 * walk. Where Node's public strict decoder accepts a whole sequence, one
 * call decodes that sequence and checks its checksums. Otherwise each
 * walked frame is decoded on its own, which is what Node 22 requires.
 */
interface PreparedDecode {
  readonly frames: readonly FrameSpan[];
  readonly consumed: number;
  readonly inputExhausted: boolean;
  readonly frameAllowanceReached?: ZstandardFrameAllowance;
  readonly options: DecompressOptions;
}

function* prepareDecode(
  bytes: Uint8Array,
  options: ZstandardDecodeOptions,
): Generator<void, PreparedDecode | ZstandardFrameFailure> {
  const resolved =
    options.allowance === undefined
      ? currentZstandardFrameAllowance()
      : { ok: true as const, value: options.allowance };
  if (!resolved.ok)
    return {
      ok: false,
      reason: "invalid_allowance",
      offset: 0,
      configuration: resolved.error,
    };
  const mode = options.mode ?? "exact";
  const walked = yield* walkFrames(bytes, resolved.value, mode);
  if ("reason" in walked) return walked;
  return {
    frames: walked.frames,
    consumed: walked.consumed,
    inputExhausted: walked.inputExhausted,
    ...(walked.frameAllowanceReached === undefined
      ? {}
      : { frameAllowanceReached: walked.frameAllowanceReached }),
    options: {
      maxOutputLength: options.maxOutputLength ?? bufferConstants.MAX_LENGTH,
      windowLogMax: options.windowLogMax ?? ZSTANDARD_WINDOW_LOG_MAX,
      ...(options.dictionary === undefined
        ? {}
        : { dictionary: options.dictionary }),
      rejectTrailing: nodeDecodesStrictSequence(),
    },
  };
}

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
  const steps = prepareDecode(bytes, options);
  let next = steps.next();
  while (!next.done) next = steps.next();
  const prepared = next.value;
  if ("reason" in prepared) return prepared;
  return decodeFrames(
    bytes,
    prepared.frames,
    prepared.consumed,
    prepared.inputExhausted,
    prepared.frameAllowanceReached,
    prepared.options,
  );
};

/** Yield point the caller uses to observe its existing abort signal. */
export type ZstandardFramePause = () => Promise<void>;

/**
 * Pause during structural validation, before decoding, and before returning
 * successful output. The strict sequence uses the async decoder. The fallback
 * pauses before each synchronous data-frame decode.
 */
export const decodeZstandardFramesCooperative = async (
  bytes: Uint8Array,
  options: ZstandardDecodeOptions,
  pause: ZstandardFramePause,
): Promise<ZstandardFrameResult> => {
  const steps = prepareDecode(bytes, options);
  let next = steps.next();
  while (!next.done) {
    await pause();
    next = steps.next();
  }
  const prepared = next.value;
  if ("reason" in prepared) return prepared;
  if (prepared.options.rejectTrailing) {
    await pause();
    const decoded = await decompressSequence(
      bytes.subarray(0, prepared.consumed),
      0,
      prepared.options,
    );
    if (isFrameFailure(decoded)) return decoded;
    const bounded = withinOutput(
      decoded.bytes,
      prepared.options.maxOutputLength,
      0,
    );
    if (isFrameFailure(bounded)) return bounded;
    await pause();
    return finishFrames(
      [bounded.bytes],
      prepared.consumed,
      prepared.frames.length,
      prepared.inputExhausted,
      prepared.frameAllowanceReached,
    );
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for (const frame of prepared.frames) {
    if (frame.kind === "skippable") continue;
    await pause();
    const step = decodeDataFrame(bytes, frame, total, prepared.options);
    if (isFrameFailure(step)) return step;
    total += step.bytes.length;
    chunks.push(step.bytes);
  }
  await pause();
  return finishFrames(
    chunks,
    prepared.consumed,
    prepared.frames.length,
    prepared.inputExhausted,
    prepared.frameAllowanceReached,
  );
};
