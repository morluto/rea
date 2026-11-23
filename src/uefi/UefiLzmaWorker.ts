import { Buffer } from "node:buffer";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { Writable } from "node:stream";
import { z } from "zod";
import { BinaryReader } from "../domain/binaryContainer.js";
import {
  decodeLimit,
  malformedInput,
  parseFailureFromCause,
  truncatedInput,
} from "../domain/parseFailure.js";
import { UEFI_FIRMWARE_LIMITS } from "../domain/uefi/uefiLimits.js";
import { errorMessage } from "../kernel/errorMessage.js";
import { sha256Hex } from "../kernel/sha256Hex.js";
import {
  encodeLzmaFrameHeader,
  LZMA_FRAME_HEADER_BYTES,
  LzmaFrameReader,
  lzmaRequestSchema,
  lzmaStreamRequestSchema,
  type UefiLzmaReply,
} from "./UefiLzmaProtocol.js";
import { undoUefiX86BranchFilter } from "./UefiX86BranchFilter.js";

const LZMA_ALONE_HEADER_BYTES = 13;
const LZMA_DICTIONARY_OFFSET = 1;
const LZMA_MIN_DICTIONARY_BYTES = 0x1000;
const LZMA_RANGE_CODER_INIT_BYTES = 5;

interface LzmaCodec {
  readonly lzma: {
    decompressFile(
      input: { readByte(): number },
      output: { writeByte(byte: number): void },
    ): void;
  };
  readonly version: string;
}

/**
 * Output sink that enforces the byte budget while the decoder writes, instead
 * of after the whole stream has expanded in memory. It grows on demand up to
 * the limit and throws as soon as the stream would cross it.
 */
class BoundedLzmaOutput {
  #buffer: Buffer;
  #used = 0;

  constructor(readonly limit: number) {
    this.#buffer = Buffer.allocUnsafe(Math.min(limit, 0x10000));
  }

  writeByte(byte: number): void {
    const position = this.#used;
    if (position >= this.limit) {
      throw decodeLimit(
        "LZMA",
        `Decompressed output exceeds the ${this.limit} byte budget.`,
        { name: "output_bytes", maximum: this.limit, required: position + 1 },
      );
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
  return { declaredOutput };
};

const loadLzmaCodec = async (): Promise<LzmaCodec> => {
  const require = createRequire(import.meta.url);
  const lzma = require("lzma-purejs") as LzmaCodec["lzma"];
  const workerModulePath = require.resolve("lzma-purejs");
  const upstreamMetadata = JSON.parse(
    await readFile(join(workerModulePath, "..", "package.json"), "utf8"),
  );
  const version = z
    .object({ version: z.string() })
    .parse(upstreamMetadata).version;
  return { lzma, version };
};

const decodeStreamPayload = (
  codec: LzmaCodec,
  payload: Buffer,
  format: "lzma" | "lzmaf86",
  maxOutputBytes: number,
): { readonly reply: UefiLzmaReply; readonly decoded?: Buffer } => {
  try {
    const { declaredOutput } = prepareLzmaInput(payload, maxOutputBytes);
    const output = new BoundedLzmaOutput(maxOutputBytes);
    let position = 0;
    const totalLength = payload.length;
    codec.lzma.decompressFile(
      {
        readByte() {
          if (position === totalLength)
            throw truncatedInput(
              "LZMA-Alone",
              "Compressed stream ends before the decoder can finish.",
            );
          const byte = payload[position]!;
          position += 1;
          return byte;
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
    if (format === "lzmaf86") undoUefiX86BranchFilter(decoded);
    return {
      decoded,
      reply: {
        ok: true,
        lzma_version: codec.version,
        input_bytes_consumed: position,
        output: {
          sha256: sha256Hex(decoded),
          bytes: decoded.length,
        },
      },
    };
  } catch (cause: unknown) {
    const failure = parseFailureFromCause(cause);
    return {
      reply: {
        ok: false,
        reason:
          failure === undefined
            ? "decoder"
            : failure.kind === "limit"
              ? "output-limit"
              : "format",
        message: errorMessage(cause),
      },
    };
  }
};

const serializeReply = (
  reply: UefiLzmaReply,
): { readonly text: string; readonly ok: boolean } => {
  const encoded = JSON.stringify(reply);
  if (Buffer.byteLength(encoded) <= UEFI_FIRMWARE_LIMITS.diagnosticBytes) {
    return { text: encoded, ok: reply.ok };
  }
  const bounded: UefiLzmaReply = {
    ok: false,
    reason: reply.ok ? "decoder" : reply.reason,
    message: "LZMA reply exceeds the diagnostic budget.",
  };
  return { text: JSON.stringify(bounded), ok: false };
};

const writeFramed = async (stream: Writable, frame: Buffer): Promise<void> => {
  if (!stream.write(frame)) {
    await once(stream, "drain");
  }
};

const runStdioWorker = async (): Promise<void> => {
  const codec = await loadLzmaCodec();
  const reader = new LzmaFrameReader(process.stdin);
  for (;;) {
    const header = await reader.readExact(LZMA_FRAME_HEADER_BYTES, {
      allowCleanEof: true,
    });
    if (header === null) break;
    const headerReader = new BinaryReader(header, false, "LZMA-Frame");
    const jsonBytes = headerReader.u32(0);
    const payloadBytes = headerReader.u32(4);
    if (
      jsonBytes === 0 ||
      jsonBytes > UEFI_FIRMWARE_LIMITS.diagnosticBytes ||
      payloadBytes > UEFI_FIRMWARE_LIMITS.inputBytes
    ) {
      throw new Error("LZMA worker request frame exceeds protocol bounds.");
    }
    const jsonBuf = await reader.readExact(jsonBytes);
    const payload = await reader.readExact(payloadBytes);
    if (jsonBuf === null || payload === null) {
      throw new Error("Truncated LZMA worker request body.");
    }
    const request = lzmaStreamRequestSchema.parse(
      JSON.parse(jsonBuf.toString("utf8")),
    );
    const { reply, decoded } = decodeStreamPayload(
      codec,
      payload,
      request.format,
      request.max_output_bytes,
    );
    const serialized = serializeReply(reply);
    const body =
      serialized.ok && decoded !== undefined ? decoded : Buffer.alloc(0);
    await writeFramed(
      process.stdout,
      encodeLzmaFrameHeader(serialized.text, body.length),
    );
    if (body.length > 0) await writeFramed(process.stdout, body);
  }
};

const runSingleFileWorker = async (requestPath: string): Promise<void> => {
  const request = lzmaRequestSchema.parse(
    JSON.parse(await readFile(requestPath, "utf8")),
  );
  let reply: UefiLzmaReply;
  try {
    const codec = await loadLzmaCodec();
    const payload = await readFile(request.payload_path);
    const outcome = decodeStreamPayload(
      codec,
      payload,
      request.format,
      request.max_output_bytes,
    );
    reply = outcome.reply;
    if (reply.ok && outcome.decoded !== undefined) {
      await writeFile(request.output_path, outcome.decoded, {
        flag: "wx",
        mode: 0o600,
      });
    }
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
  await writeFile(request.reply_path, serializeReply(reply).text, {
    flag: "wx",
    mode: 0o600,
  });
};

const main = async (): Promise<void> => {
  const arg = process.argv[2];
  if (arg === "--stdio") {
    await runStdioWorker();
    return;
  }
  if (arg === undefined) {
    throw new Error("Owned worker request path missing.");
  }
  await runSingleFileWorker(arg);
};

await main();
