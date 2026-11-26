import { createRequire } from "node:module";
import { assertArtifactReadActive } from "../resources/index.js";
import {
  BinaryFormatFailure,
  BinaryReader,
  BinaryResourceFailure,
} from "../domain/binaryContainer.js";

const LZMA_PROPS_BYTES = 5;
const LZMA_ALONE_SIZE_BYTES = 8;
const LZMA_DICTIONARY_OFFSET = 1;
const LZMA_MIN_DICTIONARY_BYTES = 0x1000;
const LZMA_RANGE_CODER_INIT_BYTES = 5;

interface LzmaCodec {
  decompressFile(
    input: { readByte(): number },
    output: { writeByte(byte: number): void },
  ): void;
}

const loadCodec = (): LzmaCodec => {
  const require = createRequire(import.meta.url);
  return require("lzma-purejs") as LzmaCodec;
};

const rejectLzma = (message: string): never => {
  throw new BinaryFormatFailure("malformed", message);
};

/** Grows up to `limit` and refuses the next byte that would cross it. */
class BoundedLzmaOutput {
  #buffer: Buffer;
  #used = 0;
  #checkpoint = 0;

  constructor(
    readonly limit: number,
    private readonly signal?: AbortSignal,
  ) {
    this.#buffer = Buffer.allocUnsafe(Math.min(limit, 0x10000));
  }

  writeByte(byte: number): void {
    const position = this.#used;
    if (position >= this.limit) {
      throw new BinaryResourceFailure(
        "structure",
        this.limit,
        "LZMA decoded length exceeds the object budget",
      );
    }
    if (position - this.#checkpoint >= 0x10000) {
      assertArtifactReadActive(this.signal);
      this.#checkpoint = position;
    }
    if (position >= this.#buffer.length) {
      const next = Buffer.allocUnsafe(
        Math.min(this.limit, Math.max(0x10000, this.#buffer.length * 2)),
      );
      this.#buffer.copy(next, 0, 0, position);
      this.#buffer = next;
    }
    this.#buffer[position] = byte;
    this.#used = position + 1;
  }

  getBuffer(): Buffer {
    return this.#buffer.subarray(0, this.#used);
  }
}

/**
 * UnityFS LZMA blocks: five property bytes plus the raw stream, with no size
 * field. The caller's declared uncompressed length becomes the LZMA-Alone size
 * so lzma-purejs can finish without an end marker.
 */
export const decodeUnityLzmaBlock = async (
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
      "LZMA decoded length exceeds the object budget",
    );
  assertArtifactReadActive(signal);
  if (input.length < LZMA_PROPS_BYTES + LZMA_RANGE_CODER_INIT_BYTES)
    return rejectLzma("Truncated Unity LZMA block");
  const props = input[0]!;
  const lc = props % 9;
  const remainder = (props / 9) | 0;
  const lp = remainder % 5;
  const pb = (remainder / 5) | 0;
  if (pb > 4 || lc + lp > 4)
    return rejectLzma("Unity LZMA properties are out of range");
  const dictionaryBytes = new BinaryReader(input, true, "Unity LZMA").u32(
    LZMA_DICTIONARY_OFFSET,
  );
  if (dictionaryBytes > maximumBytes)
    throw new BinaryResourceFailure(
      "structure",
      maximumBytes,
      "LZMA dictionary exceeds the object budget",
    );
  // Range coder state starts with a mandatory zero byte after the properties.
  if (input[LZMA_PROPS_BYTES]! !== 0)
    return rejectLzma("Unity LZMA range coder header is invalid");

  const alone = Buffer.allocUnsafe(input.length + LZMA_ALONE_SIZE_BYTES);
  input.copy(alone, 0, 0, LZMA_PROPS_BYTES);
  alone.writeBigUInt64LE(BigInt(expected), LZMA_PROPS_BYTES);
  input.copy(alone, LZMA_PROPS_BYTES + LZMA_ALONE_SIZE_BYTES, LZMA_PROPS_BYTES);
  // lzma-purejs allocates its window from the declared dictionary; EDK II and
  // Unity both promote values below 4 KiB, so normalize the private copy.
  if (dictionaryBytes < LZMA_MIN_DICTIONARY_BYTES)
    alone.writeUInt32LE(LZMA_MIN_DICTIONARY_BYTES, LZMA_DICTIONARY_OFFSET);

  const output = new BoundedLzmaOutput(
    Math.min(expected, maximumBytes),
    signal,
  );
  let position = 0;
  const codec = loadCodec();
  try {
    codec.decompressFile(
      {
        readByte() {
          if (position >= alone.length)
            return rejectLzma("Truncated Unity LZMA stream");
          return alone[position++]!;
        },
      },
      output,
    );
  } catch (cause: unknown) {
    if (
      cause instanceof BinaryFormatFailure ||
      cause instanceof BinaryResourceFailure
    )
      throw cause;
    throw new BinaryFormatFailure(
      "malformed",
      cause instanceof Error
        ? cause.message
        : "Unity LZMA block does not decode",
    );
  }
  const decoded = output.getBuffer();
  if (decoded.length !== expected)
    return rejectLzma("LZMA decoded length disagrees with its declaration");
  if (position !== alone.length)
    return rejectLzma("Unity LZMA stream has trailing bytes");
  assertArtifactReadActive(signal);
  await Promise.resolve();
  return Buffer.from(decoded);
};
