import { BinaryReader } from "../domain/binaryContainer.js";
import { sha256Hex } from "../kernel/sha256Hex.js";
import { Budget } from "../domain/budget.js";
import {
  decodeLimit,
  malformedInput,
  parseFailureFromCause,
  truncatedInput,
} from "../domain/parseFailure.js";
import { errorMessage } from "../kernel/errorMessage.js";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { z } from "zod";
import { undoUefiX86BranchFilter } from "./UefiX86BranchFilter.js";
import { lzmaRequestSchema, type UefiLzmaReply } from "./UefiLzmaProtocol.js";
import { UEFI_FIRMWARE_LIMITS } from "../domain/uefi/uefiLimits.js";

const LZMA_ALONE_HEADER_BYTES = 13;
const LZMA_DICTIONARY_OFFSET = 1;
const LZMA_MIN_DICTIONARY_BYTES = 0x1000;
const LZMA_RANGE_CODER_INIT_BYTES = 5;

/**
 * Output sink that enforces the byte budget while the decoder writes, instead
 * of after the whole stream has expanded in memory. It grows on demand up to
 * the limit and throws as soon as the stream would cross it.
 */
class BoundedLzmaOutput {
  #buffer: Buffer;
  readonly #budget: Budget;

  constructor(readonly limit: number) {
    this.#budget = new Budget(limit);
    this.#buffer = Buffer.allocUnsafe(Math.min(limit, 0x10000));
  }

  writeByte(byte: number): void {
    const position = this.#budget.used;
    if (!this.#budget.tryCharge(1))
      throw decodeLimit(
        "LZMA",
        `Decompressed output exceeds the ${this.limit} byte budget.`,
        { name: "output_bytes", maximum: this.limit, required: position + 1 },
      );
    if (position >= this.#buffer.length) {
      const next = Buffer.allocUnsafe(
        Math.min(this.limit, this.#buffer.length * 2),
      );
      this.#buffer.copy(next, 0, 0, position);
      this.#buffer = next;
    }
    this.#buffer[position] = byte;
  }

  getBuffer(): Buffer {
    return this.#buffer.subarray(0, this.#budget.used);
  }
}

const prepareLzmaInput = (payload: Buffer, maxOutputBytes: number) => {
  // .lzma (LZMA-Alone) declares the dictionary before any compressed bytes.
  // The upstream decoder allocates its window before it writes to our sink.
  if (payload.length < LZMA_ALONE_HEADER_BYTES)
    throw truncatedInput("LZMA-Alone", "Incomplete LZMA stream header.");
  const reader = new BinaryReader(payload, true, "LZMA-Alone");
  const dictionaryBytes = reader.u32(LZMA_DICTIONARY_OFFSET);
  if (dictionaryBytes > UEFI_FIRMWARE_LIMITS.lzmaOutputBytes) {
    throw decodeLimit(
      "LZMA",
      "LZMA dictionary exceeds the worker memory budget.",
      {
        name: "dictionary_bytes",
        maximum: UEFI_FIRMWARE_LIMITS.lzmaOutputBytes,
        required: dictionaryBytes,
      },
    );
  }
  const declaredOutputSize = reader.word(5, 64);
  const declaredOutput =
    declaredOutputSize === 0xffffffffffffffffn ? null : declaredOutputSize;
  if (declaredOutput !== null && declaredOutput > BigInt(maxOutputBytes)) {
    throw decodeLimit(
      "LZMA",
      `Declared LZMA output exceeds ${maxOutputBytes} bytes.`,
      {
        name: "output_bytes",
        maximum: maxOutputBytes,
        required: declaredOutput,
      },
    );
  }
  if (payload.length < LZMA_ALONE_HEADER_BYTES + LZMA_RANGE_CODER_INIT_BYTES)
    throw truncatedInput("LZMA-Alone", "Incomplete LZMA range coder header.");
  // The EDK II decoder requires zero before the four-byte range coder state.
  if (reader.u8(LZMA_ALONE_HEADER_BYTES) !== 0)
    throw malformedInput(
      "LZMA-Alone",
      "The initial LZMA range coder byte must be zero.",
    );
  // EDK II promotes small dictionary declarations to 4 KiB. lzma-purejs
  // allocates that much but otherwise checks distances against the raw value.
  // Normalize the worker's private input buffer before passing it to the codec.
  if (dictionaryBytes < LZMA_MIN_DICTIONARY_BYTES)
    payload.writeUInt32LE(LZMA_MIN_DICTIONARY_BYTES, LZMA_DICTIONARY_OFFSET);
  return { reader, declaredOutput };
};

const main = async (): Promise<void> => {
  const requestPath = process.argv[2];
  if (requestPath === undefined) {
    throw new Error("Owned worker request path missing.");
  }
  const request = lzmaRequestSchema.parse(
    JSON.parse(await readFile(requestPath, "utf8")),
  );
  let reply: UefiLzmaReply;
  try {
    const require = createRequire(import.meta.url);
    const lzma = require("lzma-purejs");
    const workerModulePath = require.resolve("lzma-purejs");
    const upstreamMetadata = JSON.parse(
      await readFile(join(workerModulePath, "..", "package.json"), "utf8"),
    );
    const decoderVersion = z
      .object({ version: z.string() })
      .parse(upstreamMetadata).version;

    const payload = await readFile(request.payload_path);
    const { reader, declaredOutput } = prepareLzmaInput(
      payload,
      request.max_output_bytes,
    );
    const output = new BoundedLzmaOutput(request.max_output_bytes);
    let position = 0;
    lzma.decompressFile(
      {
        readByte() {
          if (position === payload.length)
            throw truncatedInput(
              "LZMA-Alone",
              "Compressed stream ends before the decoder can finish.",
            );
          return reader.u8(position++);
        },
      },
      output,
    );
    const decoded = output.getBuffer();
    if (declaredOutput !== null && BigInt(decoded.length) !== declaredOutput) {
      throw malformedInput(
        "LZMA-Alone",
        `LZMA decoded ${decoded.length} bytes; stream declared ${declaredOutput} bytes.`,
      );
    }
    if (request.format === "lzmaf86") undoUefiX86BranchFilter(decoded);
    await writeFile(request.output_path, decoded, { flag: "wx", mode: 0o600 });
    reply = {
      ok: true,
      lzma_version: decoderVersion,
      input_bytes_consumed: position,
      output: {
        sha256: sha256Hex(decoded),
        bytes: decoded.length,
      },
    };
  } catch (cause: unknown) {
    const failure = parseFailureFromCause(cause);
    reply = {
      ok: false,
      reason:
        failure === undefined
          ? "decoder"
          : failure.kind === "limit"
            ? "output-limit"
            : "format",
      message: errorMessage(cause),
    };
  }
  let encoded = JSON.stringify(reply);
  if (Buffer.byteLength(encoded) > UEFI_FIRMWARE_LIMITS.diagnosticBytes) {
    const bounded: UefiLzmaReply = {
      ok: false,
      reason: reply.ok ? "decoder" : reply.reason,
      message: "LZMA reply exceeds the diagnostic budget.",
    };
    encoded = JSON.stringify(bounded);
  }
  await writeFile(request.reply_path, encoded, { flag: "wx", mode: 0o600 });
};

await main();
