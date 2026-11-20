import {
  ZSTANDARD_MAGIC_BYTES,
  zstandardFrameKind,
  zstandardFrameReads,
  type ZstandardFrameRead,
} from "./zstandardFrameWire.js";

export class ZstandardFramingError extends Error {
  constructor(
    readonly code: string,
    readonly offset: number,
  ) {
    super(`Zstandard framing failed at byte ${offset}: ${code}`);
  }
}

const magicRead = (offset: number): ZstandardFrameRead => ({
  length: ZSTANDARD_MAGIC_BYTES,
  inspect: true,
  eof: "truncated_frame_header",
  failureOffset: offset,
});

/**
 * Yield compressed slices whose boundaries never cross two frames. Node 22
 * stops a decode call at its first frame end, but its stream can accept later
 * frames in separate writes. Chunk boundaries may also split a frame.
 */
export async function* zstandardFrameChunks(
  input: AsyncIterable<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  // Only inspected fields that span chunks are copied. Magic and skippable
  // size are the widest inspected fields (four bytes).
  const header = new Uint8Array(ZSTANDARD_MAGIC_BYTES);
  const unread = new Uint8Array(0);
  let offset = 0;
  let frameOffset = 0;
  let read = magicRead(frameOffset);
  let supplied = 0;
  let reads: ReturnType<typeof zstandardFrameReads> | undefined;
  for await (const bytes of input) {
    let start = 0;
    let cursor = 0;
    while (cursor < bytes.length) {
      const count = Math.min(read.length - supplied, bytes.length - cursor);
      const end = cursor + count;
      const complete = supplied + count === read.length;
      let field: Uint8Array = unread;
      if (read.inspect) {
        if (supplied === 0 && complete) {
          field = bytes.subarray(cursor, end);
        } else {
          header.set(bytes.subarray(cursor, end), supplied);
          field = header;
        }
      }
      cursor = end;
      offset += count;
      if (!complete) {
        supplied += count;
        break;
      }
      supplied = 0;
      if (reads === undefined) {
        const kind = zstandardFrameKind(field, 0);
        if (kind === undefined)
          throw new ZstandardFramingError("magic", frameOffset);
        reads = zstandardFrameReads(kind, frameOffset);
      }
      let step = reads.next(field);
      // A reserved/empty length never needs another input chunk.
      while (!step.done && step.value.length === 0) step = reads.next(unread);
      if (!step.done) {
        read = step.value;
        continue;
      }
      if (step.value !== undefined)
        throw new ZstandardFramingError(step.value.code, step.value.offset);
      yield bytes.subarray(start, cursor);
      start = cursor;
      frameOffset = offset;
      reads = undefined;
      read = magicRead(frameOffset);
    }
    if (start < bytes.length) yield bytes.subarray(start);
  }
  if (reads !== undefined || supplied !== 0 || frameOffset === 0)
    throw new ZstandardFramingError(read.eof, read.failureOffset);
}
