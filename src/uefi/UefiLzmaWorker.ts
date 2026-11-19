import { BinaryReader } from "../domain/binaryContainer.js";
import { sha256Hex } from "../kernel/sha256Hex.js";
import { Budget } from "../domain/budget.js";
import { decodeLimit, parseFailureFromCause } from "../domain/parseFailure.js";
import { errorMessage } from "../kernel/errorMessage.js";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { z } from "zod";
import { undoUefiX86BranchFilter } from "./UefiX86BranchFilter.js";
import { UEFI_FIRMWARE_LIMITS } from "../domain/uefi/uefiLimits.js";

const requestSchema = z.strictObject({
  format: z.enum(["lzma", "lzmaf86"]),
  payload_path: z.string(),
  output_path: z.string(),
  reply_path: z.string(),
  max_output_bytes: z
    .number()
    .int()
    .min(1)
    .max(UEFI_FIRMWARE_LIMITS.lzmaOutputBytes),
});

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

const main = async (): Promise<void> => {
  const requestPath = process.argv[2];
  if (requestPath === undefined) {
    throw new Error("Owned worker request path missing.");
  }
  const request = requestSchema.parse(
    JSON.parse(await readFile(requestPath, "utf8")),
  );
  let reply: unknown;
  try {
    const require2 = createRequire(import.meta.url);
    const lzma = require2("lzma-purejs");
    const workerModulePath = require2.resolve("lzma-purejs");
    const upstreamMetadata = JSON.parse(
      await readFile(join(workerModulePath, "..", "package.json"), "utf8"),
    );
    const decoderVersion = z
      .object({ version: z.string() })
      .parse(upstreamMetadata).version;

    const payload = await readFile(request.payload_path);
    // .lzma (LZMA-Alone) declares the dictionary before any compressed bytes.
    // The upstream decoder allocates its window before it writes to our sink.
    if (payload.length < 13)
      throw new Error("Incomplete LZMA stream properties.");
    const reader = new BinaryReader(payload, true, "LZMA-Alone");
    const dictionaryBytes = reader.u32(1);
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
    if (
      declaredOutput !== null &&
      declaredOutput > BigInt(request.max_output_bytes)
    ) {
      throw decodeLimit(
        "LZMA",
        `Declared LZMA output exceeds ${request.max_output_bytes} bytes.`,
        {
          name: "output_bytes",
          maximum: request.max_output_bytes,
          required: declaredOutput,
        },
      );
    }
    const output = new BoundedLzmaOutput(request.max_output_bytes);
    lzma.decompressFile(payload, output);
    const decoded = output.getBuffer();
    if (declaredOutput !== null && BigInt(decoded.length) !== declaredOutput) {
      throw new Error(
        `LZMA decoded ${decoded.length} bytes; stream declared ${declaredOutput} bytes.`,
      );
    }
    if (request.format === "lzmaf86") undoUefiX86BranchFilter(decoded);
    await writeFile(request.output_path, decoded, { flag: "wx", mode: 0o600 });
    reply = {
      ok: true,
      lzma_version: decoderVersion,
      output: {
        sha256: sha256Hex(decoded),
        bytes: decoded.length,
      },
    };
  } catch (cause: unknown) {
    const message = errorMessage(cause);
    reply = {
      ok: false,
      reason:
        parseFailureFromCause(cause)?.kind === "limit"
          ? "output-limit"
          : message.includes("properties")
            ? "format"
            : "decoder",
      message,
    };
  }
  let encoded = JSON.stringify(reply);
  if (Buffer.byteLength(encoded) > UEFI_FIRMWARE_LIMITS.diagnosticBytes) {
    encoded = JSON.stringify({
      ok: false,
      reason: "output-limit",
      message: "LZMA reply exceeds the diagnostic budget.",
    });
  }
  await writeFile(request.reply_path, encoded, { flag: "wx", mode: 0o600 });
};

await main();
