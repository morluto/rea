const ZSTD_MAGIC = 0xfd2fb528;
const SKIPPABLE_MAGIC_MIN = 0x184d2a50;
const SKIPPABLE_MAGIC_MAX = 0x184d2a5f;
export const ZSTANDARD_MAGIC_BYTES = 4;

export type ZstandardFrameKind = "zstd" | "skippable";

type Truncation =
  | "truncated_frame_header"
  | "truncated_block"
  | "truncated_checksum";

export interface ZstandardFrameRead {
  readonly length: number;
  readonly inspect: boolean;
  readonly eof: Truncation;
  readonly failureOffset: number;
}

type FrameWireFailureCode = "reserved_frame_descriptor" | "reserved_block";

const u24 = (bytes: Uint8Array, offset: number): number =>
  (bytes[offset] ?? 0) |
  ((bytes[offset + 1] ?? 0) << 8) |
  ((bytes[offset + 2] ?? 0) << 16);

const u32 = (bytes: Uint8Array, offset: number): number =>
  (u24(bytes, offset) | ((bytes[offset + 3] ?? 0) << 24)) >>> 0;

export const zstandardFrameKind = (
  bytes: Uint8Array,
  offset: number,
): ZstandardFrameKind | undefined => {
  if (bytes.length - offset < ZSTANDARD_MAGIC_BYTES) return undefined;
  const magic = u32(bytes, offset);
  if (magic === ZSTD_MAGIC) return "zstd";
  if (magic >= SKIPPABLE_MAGIC_MIN && magic <= SKIPPABLE_MAGIC_MAX)
    return "skippable";
  return undefined;
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
