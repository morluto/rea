const ZSTD_MAGIC = 0xfd2fb528;
const ZSTD_MAGIC_BYTES = [0x28, 0xb5, 0x2f, 0xfd] as const;
const SKIPPABLE_MAGIC_MIN = 0x184d2a50;
const SKIPPABLE_MAGIC_MAX = 0x184d2a5f;
const SKIPPABLE_MAGIC_REST = [0x2a, 0x4d, 0x18] as const;
export const ZSTANDARD_MAGIC_BYTES = 4;

export type ZstandardFrameKind = "zstd" | "skippable";

export const ZSTANDARD_TRUNCATION_REASONS = [
  "truncated_frame_header",
  "truncated_block",
  "truncated_checksum",
] as const;

export type ZstandardTruncationReason =
  (typeof ZSTANDARD_TRUNCATION_REASONS)[number];

export interface ZstandardFrameRead {
  readonly length: number;
  readonly inspect: boolean;
  readonly eof: ZstandardTruncationReason;
  readonly failureOffset: number;
}

type FrameWireFailureCode = "reserved_frame_descriptor" | "reserved_block";

const u24 = (bytes: Uint8Array, offset: number): number =>
  (bytes[offset] ?? 0) |
  ((bytes[offset + 1] ?? 0) << 8) |
  ((bytes[offset + 2] ?? 0) << 16);

const u32 = (bytes: Uint8Array, offset: number): number =>
  (u24(bytes, offset) | ((bytes[offset + 3] ?? 0) << 24)) >>> 0;

export type ZstandardFrameMagicStatus =
  | ZstandardFrameKind
  | "incomplete"
  | "none";

/**
 * Inspect the next 4-byte Zstandard or skippable frame magic at `offset`,
 * distinguishing a complete frame magic, an incomplete 0-3 byte magic prefix
 * that could continue with more input, and a definite non-frame byte sequence.
 */
export const zstandardFrameMagicStatus = (
  bytes: Uint8Array,
  offset: number,
): ZstandardFrameMagicStatus => {
  const remaining = bytes.length - offset;
  if (remaining <= 0) return "incomplete";
  if (remaining >= ZSTANDARD_MAGIC_BYTES) {
    const magic = u32(bytes, offset);
    if (magic === ZSTD_MAGIC) return "zstd";
    if (magic >= SKIPPABLE_MAGIC_MIN && magic <= SKIPPABLE_MAGIC_MAX)
      return "skippable";
    return "none";
  }
  let matchesZstd = true;
  for (let index = 0; index < remaining; index += 1)
    if (bytes[offset + index] !== ZSTD_MAGIC_BYTES[index]) {
      matchesZstd = false;
      break;
    }
  if (matchesZstd) return "incomplete";
  const first = bytes[offset]!;
  if (first < 0x50 || first > 0x5f) return "none";
  for (let index = 1; index < remaining; index += 1)
    if (bytes[offset + index] !== SKIPPABLE_MAGIC_REST[index - 1])
      return "none";
  return "incomplete";
};

export const zstandardFrameKind = (
  bytes: Uint8Array,
  offset: number,
): ZstandardFrameKind | undefined => {
  const status = zstandardFrameMagicStatus(bytes, offset);
  return status === "zstd" || status === "skippable" ? status : undefined;
};

/**
 * RFC 8878 §3.1 frame extent after its magic. The caller supplies inspected
 * fields and skips opaque bytes, which remain the native decoder's concern.
 */
export function* zstandardFrameReads(
  kind: ZstandardFrameKind,
  offset: number,
): Generator<
  ZstandardFrameRead,
  { readonly code: FrameWireFailureCode; readonly offset: number } | undefined,
  Uint8Array
> {
  let cursor = offset + ZSTANDARD_MAGIC_BYTES;
  const header = (length: number, inspect: boolean): ZstandardFrameRead => ({
    length,
    inspect,
    eof: "truncated_frame_header",
    failureOffset: offset,
  });
  if (kind === "skippable") {
    const userSize = yield header(4, true);
    yield {
      length: u32(userSize, 0),
      inspect: false,
      eof: "truncated_block",
      failureOffset: cursor + 4,
    };
    return undefined;
  }

  const descriptor = (yield header(1, true))[0] ?? 0;
  if (descriptor & 0x08) return { code: "reserved_frame_descriptor", offset };
  const singleSegment = (descriptor & 0x20) !== 0;
  const dictionaryFlag = descriptor & 0x03;
  const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
  const contentSizeFlag = descriptor >>> 6;
  const contentSizeBytes =
    contentSizeFlag === 0 ? Number(singleSegment) : 2 ** contentSizeFlag;
  const headerRest =
    Number(!singleSegment) + dictionaryBytes + contentSizeBytes;
  yield header(headerRest, false);
  cursor += 1 + headerRest;

  for (;;) {
    const block = u24(
      yield {
        length: 3,
        inspect: true,
        eof: "truncated_block",
        failureOffset: cursor,
      },
      0,
    );
    const type = (block >>> 1) & 3;
    if (type === 3) return { code: "reserved_block", offset: cursor };
    cursor += 3;
    // An RLE block stores one byte and repeats it the declared number of times.
    const length = type === 1 ? 1 : block >>> 3;
    yield {
      length,
      inspect: false,
      eof: "truncated_block",
      failureOffset: cursor,
    };
    cursor += length;
    if (block & 1) break;
  }
  if (descriptor & 0x04)
    yield {
      length: 4,
      inspect: false,
      eof: "truncated_checksum",
      failureOffset: cursor,
    };
  return undefined;
}
