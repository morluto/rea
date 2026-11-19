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
    const decoded = Buffer.from(lzma.decompressFile(payload) as Uint8Array);
    if (decoded.length > request.max_output_bytes) {
      throw new UefiLzmaOutputLimit(
        `Decompressed output ${decoded.length} exceeds the ${request.max_output_bytes} byte budget.`,
      );
    }
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
