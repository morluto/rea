import { Buffer } from "node:buffer";
import type { Readable } from "node:stream";
import { z } from "zod";

import { digestSchema } from "../domain/digests.js";
import { UEFI_FIRMWARE_LIMITS } from "../domain/uefi/uefiLimits.js";
import { UefiLzmaByteQueue } from "./UefiLzmaByteQueue.js";

const decodeFailureReasonSchema = z.enum(["format", "decoder", "output-limit"]);
export type UefiDecodeFailureReason = z.infer<typeof decodeFailureReasonSchema>;

export const LZMA_FRAME_HEADER_BYTES = 8;

export const lzmaStreamRequestSchema = z.strictObject({
  format: z.enum(["lzma", "lzmaf86"]),
  max_output_bytes: z
    .number()
    .int()
    .min(1)
    .max(UEFI_FIRMWARE_LIMITS.lzmaOutputBytes),
});

export type UefiLzmaStreamRequest = z.infer<typeof lzmaStreamRequestSchema>;

export const lzmaRequestSchema = z.strictObject({
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

export const lzmaReplySchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    lzma_version: z.string(),
    input_bytes_consumed: z
      .number()
      .int()
      .min(1)
      .max(UEFI_FIRMWARE_LIMITS.inputBytes),
    output: z.strictObject({
      sha256: digestSchema,
      bytes: z.number().int().min(0),
    }),
  }),
  z.strictObject({
    ok: z.literal(false),
    reason: decodeFailureReasonSchema,
    message: z.string(),
  }),
]);

export type UefiLzmaReply = z.infer<typeof lzmaReplySchema>;

/**
 * Encode `[u32BE jsonBytes][u32BE bodyBytes][jsonUtf8]` for framed stdio IPC.
 * Callers write any non-empty `body` directly after the header to avoid
 * copying up to 128 MiB payloads into a combined frame buffer.
 */
export const encodeLzmaFrameHeader = (
  headerJson: string,
  bodyLength: number,
): Buffer => {
  const jsonBuf = Buffer.from(headerJson, "utf8");
  const header = Buffer.allocUnsafe(LZMA_FRAME_HEADER_BYTES + jsonBuf.length);
  header.writeUInt32BE(jsonBuf.length, 0);
  header.writeUInt32BE(bodyLength, 4);
  jsonBuf.copy(header, LZMA_FRAME_HEADER_BYTES);
  return header;
};

const LZMA_READER_HIGH_WATER_BYTES = 4 * 1024 * 1024;

export interface LzmaFrameReadOptions {
  readonly allowCleanEof?: boolean;
  readonly signal?: AbortSignal;
  readonly onAbort?: () => unknown;
  readonly isClosed?: () => boolean;
  readonly onError?: (cause: unknown) => unknown;
  readonly onEof?: () => unknown;
}

/**
 * Framed byte-stream reader shared by the UEFI LZMA host session and stdio
 * worker, with high-water stream pause/resume backpressure.
 */
export class LzmaFrameReader {
  readonly #queue = new UefiLzmaByteQueue();
  #ended = false;
  #error: unknown;
  #waiter: (() => void) | undefined;
  #paused = false;

  constructor(private readonly stream: Readable) {
    stream.on("data", this.#onData);
    stream.once("end", this.#onEnd);
    stream.once("error", this.#onError);
  }

  readonly #onData = (chunk: Buffer): void => {
    if (!this.#queue.append(chunk)) return;
    if (
      !this.#paused &&
      this.#queue.available >= LZMA_READER_HIGH_WATER_BYTES
    ) {
      this.#paused = true;
      this.stream.pause();
    }
    this.#wake();
  };

  readonly #onEnd = (): void => {
    this.#ended = true;
    this.#wake();
  };

  readonly #onError = (cause: unknown): void => {
    this.#error = cause;
    this.#wake();
  };

  #wake(): void {
    const wake = this.#waiter;
    this.#waiter = undefined;
    wake?.();
  }

  #maybeResume(needed: number): void {
    if (
      this.#paused &&
      !this.#ended &&
      this.#error === undefined &&
      (this.#queue.available < needed ||
        this.#queue.available < LZMA_READER_HIGH_WATER_BYTES / 2)
    ) {
      this.#paused = false;
      this.stream.resume();
    }
  }

  dispose(): void {
    this.stream.off("data", this.#onData);
    this.stream.off("end", this.#onEnd);
    this.stream.off("error", this.#onError);
    this.#wake();
  }

  async readExact(
    length: number,
    options?: LzmaFrameReadOptions & { readonly allowCleanEof?: false },
  ): Promise<Buffer>;
  async readExact(
    length: number,
    options: LzmaFrameReadOptions & { readonly allowCleanEof: true },
  ): Promise<Buffer | null>;
  async readExact(
    length: number,
    options: LzmaFrameReadOptions = {},
  ): Promise<Buffer | null> {
    if (length === 0) return Buffer.alloc(0);
    const { signal, onAbort, isClosed, onError, onEof, allowCleanEof } =
      options;
    while (this.#queue.available < length) {
      if (signal?.aborted) throw onAbort ? onAbort() : signal.reason;
      if (this.#error !== undefined)
        throw onError ? onError(this.#error) : this.#error;
      if (this.#ended || isClosed?.() === true) {
        if (allowCleanEof && this.#queue.available === 0) return null;
        throw onEof ? onEof() : new Error("Truncated LZMA worker frame.");
      }
      this.#maybeResume(length);
      await new Promise<void>((resolve, reject) => {
        const handleAbort = () => {
          this.#waiter = undefined;
          reject(onAbort ? onAbort() : signal?.reason);
        };
        if (signal?.aborted) {
          handleAbort();
          return;
        }
        signal?.addEventListener("abort", handleAbort, { once: true });
        this.#waiter = () => {
          signal?.removeEventListener("abort", handleAbort);
          resolve();
        };
      });
    }
    const result = this.#queue.read(length);
    this.#maybeResume(0);
    return result;
  }
}
