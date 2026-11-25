import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import {
  BinaryFormatFailure,
  BinaryReader,
  BinaryResourceFailure,
} from "../domain/binaryContainer.js";
import {
  ArtifactReaderFailure,
  assertArtifactReadActive,
} from "../resources/index.js";

const PROPERTIES_BYTES = 5;
const RANGE_CODER_BYTES = 5;
const MIN_DICTIONARY_BYTES = 4096;

// This is trusted, fixed worker code, not source derived from the target.
// A synchronous codec must not block cancellation on the service thread.
// Like the UEFI decoder, feed lzma-purejs a bounded input stream and sink.
const WORKER_SOURCE = `
import { parentPort, workerData } from "node:worker_threads";
import { createRequire } from "node:module";
const codec = createRequire(workerData.codecPath)(workerData.codecPath);
const { input, expected, dictionary } = workerData;
const header = Buffer.alloc(13);
header.set(input.subarray(0, 5));
header.writeUInt32LE(dictionary, 1);
header.writeBigUInt64LE(BigInt(expected), 5);
let read = 0;
let written = 0;
const output = new Uint8Array(expected);
try {
  codec.decompressFile({
    readByte() {
      if (read < header.length) return header[read++];
      const position = read++ - header.length + 5;
      if (position >= input.length) throw new Error("Truncated LZMA stream");
      return input[position];
    }
  }, {
    writeByte(value) {
      if (written >= expected) throw new Error("LZMA output exceeds declared size");
      output[written++] = value;
    }
  });
  if (written !== expected) throw new Error("LZMA output size mismatch");
  parentPort.postMessage(output, [output.buffer]);
} catch {
  parentPort.postMessage("malformed");
}
`;

/**
 * Decode a raw LZMA1 block with five property bytes (as used by UnityFS).
 * The caller supplies the trusted, previously admitted output length.
 * No end-of-stream marker is required when the output length is known.
 */
export const decodeLzmaBlock = async (
  encoded: Buffer,
  expected: number,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<Buffer> => {
  assertArtifactReadActive(signal);
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
  if (encoded.length < PROPERTIES_BYTES + RANGE_CODER_BYTES)
    throw new BinaryFormatFailure("truncated", "Incomplete raw LZMA header");
  if (encoded[0]! >= 225 || encoded[PROPERTIES_BYTES] !== 0)
    throw new BinaryFormatFailure(
      "malformed",
      "Invalid raw LZMA properties or range coder lead-in",
    );
  const dictionary = Math.max(
    MIN_DICTIONARY_BYTES,
    new BinaryReader(encoded, true, "unityfs").u32(1),
  );
  if (dictionary > maximumBytes)
    throw new BinaryResourceFailure(
      "structure",
      maximumBytes,
      "LZMA dictionary exceeds the decoder memory budget",
    );
  // Transfer a private, exact-length input. Never detach a caller-owned Buffer.
  const input = Uint8Array.from(encoded);
  const codecPath = createRequire(import.meta.url).resolve("lzma-purejs");
  const worker = new Worker(
    new URL(`data:text/javascript,${encodeURIComponent(WORKER_SOURCE)}`),
    {
      execArgv: [],
      workerData: { input, expected, dictionary, codecPath },
      transferList: [input.buffer],
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    },
  );
  let onAbort: (() => void) | undefined;
  let bytes: Buffer;
  try {
    bytes = await new Promise<Buffer>((resolve, reject) => {
      onAbort = () => {
        try {
          assertArtifactReadActive(signal);
        } catch (cause: unknown) {
          reject(cause);
        }
      };
      worker.once("message", (message: unknown) => {
        if (message === "malformed") {
          reject(
            new BinaryFormatFailure(
              "malformed",
              "Invalid or incomplete LZMA stream",
            ),
          );
        } else if (
          message instanceof Uint8Array &&
          message.byteLength === expected
        ) {
          resolve(
            Buffer.from(message.buffer, message.byteOffset, message.byteLength),
          );
        } else {
          reject(
            new ArtifactReaderFailure(
              "unavailable",
              "LZMA worker returned an invalid result",
            ),
          );
        }
      });
      worker.once("error", (cause) => {
        reject(
          new ArtifactReaderFailure("unavailable", "LZMA worker failed", {
            cause,
          }),
        );
      });
      worker.once("exit", (code) => {
        reject(
          new ArtifactReaderFailure(
            "unavailable",
            `LZMA worker exited without a result (${String(code)})`,
          ),
        );
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted === true) onAbort();
    });
  } finally {
    if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
    // Join the exact worker even if the caller cancels or the codec fails.
    await worker.terminate();
  }
  assertArtifactReadActive(signal);
  return bytes;
};
