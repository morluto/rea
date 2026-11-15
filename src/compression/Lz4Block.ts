import { scheduler } from "node:timers/promises";
import { assertArtifactReadActive } from "../resources/index.js";
import {
  BinaryFormatFailure,
  BinaryResourceFailure,
} from "../domain/binaryContainer.js";
const rejectLz4 = (message: string): never => {
  throw new BinaryFormatFailure("malformed", message);
};
/**
 * Raw LZ4 blocks (CUDA's 0x2000 mode, UnityFS blocks); not an LZ4 frame
 * decoder. `maximumBytes` is the caller's decoded-output budget.
 */
export const decodeLz4Block = async (
  input: Buffer,
  expected: number,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<Buffer> => {
  if (
    !Number.isSafeInteger(expected) ||
    expected < 0 ||
    expected > maximumBytes
  )
    throw new BinaryResourceFailure(
      "structure",
      maximumBytes,
      "LZ4 decoded length exceeds the object budget",
    );
  const output = Buffer.alloc(expected);
  let read = 0,
    write = 0,
    checkpoint = 0;
  const byte = (): number => {
    if (read >= input.length) return rejectLz4("Truncated LZ4 block");
    return input[read++]!;
  };
  const length = (nibble: number, remaining: number): number => {
    let total = nibble;
    if (nibble === 15) {
      let extra: number;
      do {
        extra = byte();
        if (extra > remaining - total)
          rejectLz4("LZ4 length exceeds its declared output");
        total += extra;
      } while (extra === 255);
    }
    if (total > remaining) rejectLz4("LZ4 length exceeds its declared output");
    return total;
  };
  while (read < input.length) {
    if (write - checkpoint >= 4 * 1024 * 1024) {
      await scheduler.yield();
      checkpoint = write;
    }
    assertArtifactReadActive(signal);
    const token = byte();
    const literals = length(token >>> 4, expected - write);
    if (literals > input.length - read)
      rejectLz4("LZ4 literals exceed their encoded input");
    input.copy(output, write, read, read + literals);
    read += literals;
    write += literals;
    if (read === input.length) break;
    const distance = byte() | (byte() << 8);
    if (distance === 0 || distance > write)
      rejectLz4("LZ4 match has an invalid backward distance");
    const match = length(token & 15, expected - write - 4) + 4;
    let copied = Math.min(distance, match);
    output.copy(output, write, write - distance, write - distance + copied);
    // Grow the already decoded pattern; Buffer.copy alone has memmove rather than LZ4 overlap semantics.
    while (copied < match) {
      const count = Math.min(copied, match - copied);
      output.copy(output, write + copied, write, write + count);
      copied += count;
    }
    write += match;
  }
  if (write !== expected)
    rejectLz4("LZ4 decoded length disagrees with its declaration");
  assertArtifactReadActive(signal);
  return output;
};
