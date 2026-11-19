import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { z } from "zod";
import { UEFI_FIRMWARE_LIMITS } from "../domain/uefi/uefiLimits.js";

const requestSchema = z.strictObject({
  payload_path: z.string(),
  output_path: z.string(),
  reply_path: z.string(),
  max_output_bytes: z
    .number()
    .int()
    .min(1)
    .max(UEFI_FIRMWARE_LIMITS.lzmaOutputBytes),
});

class UefiLzmaOutputLimit extends Error {}

/**
 * Output sink that enforces the byte budget while the decoder writes, instead
 * of after the whole stream has expanded in memory. It grows on demand up to
 * the limit and throws as soon as the stream would cross it.
 */
class BoundedLzmaOutput {
  #buffer: Buffer;
  #pos = 0;

  constructor(readonly limit: number) {
    this.#buffer = Buffer.allocUnsafe(Math.min(limit, 0x10000));
  }

  writeByte(byte: number): void {
    if (this.#pos >= this.limit) {
      throw new UefiLzmaOutputLimit(
        `Decompressed output exceeds the ${this.limit} byte budget.`,
      );
    }
    if (this.#pos >= this.#buffer.length) {
      const next = Buffer.allocUnsafe(
        Math.min(this.limit, this.#buffer.length * 2),
      );
      this.#buffer.copy(next, 0, 0, this.#pos);
      this.#buffer = next;
    }
    this.#buffer[this.#pos++] = byte;
  }

  getBuffer(): Buffer {
    return this.#buffer.subarray(0, this.#pos);
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
    const output = new BoundedLzmaOutput(request.max_output_bytes);
    lzma.decompressFile(payload, output);
    const decoded = output.getBuffer();
    await writeFile(request.output_path, decoded, { flag: "wx", mode: 0o600 });
    reply = {
      ok: true,
      lzma_version: decoderVersion,
      output: {
        sha256: createHash("sha256").update(decoded).digest("hex"),
        bytes: decoded.length,
      },
    };
  } catch (cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause);
    reply = {
      ok: false,
      reason:
        cause instanceof UefiLzmaOutputLimit
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
