import { Buffer } from "node:buffer";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { Writable } from "node:stream";
import { z } from "zod";
import { BinaryReader } from "../domain/binaryContainer.js";
import { UEFI_FIRMWARE_LIMITS } from "../domain/uefi/uefiLimits.js";
import { errorMessage } from "../kernel/errorMessage.js";
import { sha256Hex } from "../kernel/sha256Hex.js";
import {
  encodeLzmaFrameHeader,
  LZMA_FRAME_HEADER_BYTES,
  LzmaFrameReader,
  lzmaStreamRequestSchema,
  type UefiLzmaReply,
} from "./UefiLzmaProtocol.js";
import { undoUefiX86BranchFilter } from "./UefiX86BranchFilter.js";
import {
  decodeLzma1Alone,
  type Lzma1Codec,
  type Lzma1Refusal,
} from "../compression/Lzma1.js";
import { readLzma1AloneHeader } from "../compression/Lzma1Header.js";

interface LzmaCodec {
  readonly lzma: Lzma1Codec;
  readonly version: string;
}

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

/** A verdict about the stream; worker faults are reported as `decoder`. */
const replyReason = (refusal: Lzma1Refusal): "output-limit" | "malformed" =>
  refusal.kind === "output-limit" ? "output-limit" : "malformed";

/**
 * EFI_LZMA_CUSTOM_DECOMPRESS sections carry an LZMA-Alone stream: the EDK II
 * `LZMA_HEADER_SIZE` (13-byte) header, then the coded bytes. The shared
 * LZMA1 owner decides every fact about the stream; this worker keeps only the
 * UEFI x86 branch filter and the reply protocol.
 */
const decodeStreamPayload = (
  codec: LzmaCodec,
  payload: Buffer,
  format: "lzma" | "lzmaf86",
  maxOutputBytes: number,
): { readonly reply: UefiLzmaReply; readonly decoded?: Buffer } => {
  let result: ReturnType<typeof decodeLzma1Alone>;
  try {
    const header = readLzma1AloneHeader(payload);
    result = header.ok
      ? decodeLzma1Alone(codec.lzma, payload, header, {
          outputLimit: maxOutputBytes,
        })
      : header;
  } catch (cause: unknown) {
    // Not a verdict about the stream: a fault in this worker's decoding.
    return {
      reply: { ok: false, reason: "decoder", message: errorMessage(cause) },
    };
  }
  if (!result.ok)
    return {
      reply: {
        ok: false,
        reason: replyReason(result),
        message: result.message,
      },
    };
  const decoded = result.output;
  if (format === "lzmaf86") undoUefiX86BranchFilter(decoded);
  return {
    decoded,
    reply: {
      ok: true,
      lzma_version: codec.version,
      input_bytes_consumed: result.consumed,
      output: {
        sha256: sha256Hex(decoded),
        bytes: decoded.length,
      },
    },
  };
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

if (process.argv[2] !== "--stdio")
  throw new Error("Owned LZMA worker requires framed stdio.");

await runStdioWorker();
