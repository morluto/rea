import type { FileHandle } from "node:fs/promises";
import { pipeline, Readable } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { createGunzip, type Gunzip } from "node:zlib";

import { readFileHandleChunks } from "../../filesystem/readFileHandleChunks.js";
import { readArtifactFileBytes } from "../ArtifactFileRange.js";
import { assertArtifactReadActive } from "../../resources/index.js";

const SCAN_CHUNK_BYTES = 64 * 1024;

/** Unconsumed non-zero carrier bytes left after the stream ended. */
export interface TrailingCarrierBytes {
  readonly offset: number;
  readonly nonZeroBytes: number;
}

/** Why the decompressed tar stream ended before its own end. */
export class TarStreamEnded extends Error {
  constructor(
    readonly kind: "malformed" | "truncated",
    readonly detail: string,
  ) {
    super(detail);
    this.name = "TarStreamEnded";
  }
}

/**
 * The tar byte stream: the carrier itself, or its gzip decompression. Reads
 * return fewer bytes only at the end of the stream.
 */
export interface TarByteStream {
  /** Offset in the tar stream (the decompressed stream for gzip). */
  readonly position: number;
  read(length: number, signal?: AbortSignal): Promise<Buffer>;
  /** Advance up to `length` bytes; returns the bytes skipped. */
  skip(length: number, signal?: AbortSignal): Promise<number>;
  /**
   * Count non-zero carrier bytes left after the stream reached EOF (for
   * example, data appended after zero padding following a gzip member).
   */
  trailingCarrierNonZero(signal?: AbortSignal): Promise<TrailingCarrierBytes>;
  close(): void;
}

/** Positional reads of an uncompressed tar carrier. */
export class PlainTarStream implements TarByteStream {
  #position = 0;

  constructor(
    private readonly handle: Pick<FileHandle, "read">,
    private readonly size: number,
  ) {}

  get position(): number {
    return this.#position;
  }

  async read(length: number, signal?: AbortSignal): Promise<Buffer> {
    const available = Math.min(length, this.size - this.#position);
    const bytes = await readArtifactFileBytes(
      "tar",
      this.handle,
      this.#position,
      available,
      this.size,
      signal,
    );
    this.#position += bytes.length;
    return bytes;
  }

  skip(length: number): Promise<number> {
    const skipped = Math.min(length, this.size - this.#position);
    this.#position += skipped;
    return Promise.resolve(skipped);
  }

  trailingCarrierNonZero(): Promise<TrailingCarrierBytes> {
    return Promise.resolve({ offset: this.#position, nonZeroBytes: 0 });
  }

  close(): void {
    this.#position = this.size;
  }
}

/** RFC 1952 member trailer: CRC32 and ISIZE. */
const GZIP_TRAILER_BYTES = 8;

/**
 * The carrier's bytes, with the final 8 in a write of their own. zlib emits
 * no output for a write that ends in a failed trailer check, so separating
 * the last member's trailer keeps its decompressed data observable.
 */
async function* compressedInput(
  handle: Pick<FileHandle, "read">,
  size: number,
): AsyncGenerator<Buffer> {
  const split = Math.max(0, size - GZIP_TRAILER_BYTES);
  if (split > 0)
    yield* readFileHandleChunks(handle, { start: 0, end: split - 1 });
  if (size > split)
    yield* readFileHandleChunks(handle, { start: split, end: size - 1 });
}

/** Decompressed bytes queued before the inflater is paused. */
const QUEUE_HIGH_WATER_BYTES = 1024 * 1024;

/**
 * The RFC 1952 decompression of a gzip carrier, pulled on demand. Every
 * decompressed byte is charged before it is used, so expansion stays within
 * the caller's plaintext-work allowance.
 *
 * Output is queued from `data` events rather than read through the stream's
 * iterator: zlib can report a damaged trailer in the same input chunk that
 * produced the data, and destroying a paused stream would drop that data.
 * Bytes that arrived before a failure are therefore served first, and the
 * failure follows them. The queue is bounded by pausing the inflater, and
 * every chunk is charged when zlib produces it, before it is queued.
 */
export class GzipTarStream implements TarByteStream {
  #position = 0;
  #pending: Buffer = Buffer.alloc(0);
  readonly #handle: Pick<FileHandle, "read">;
  readonly #size: number;
  readonly #gunzip: Gunzip;
  readonly #output: Readable;
  readonly #queue: Buffer[] = [];
  #queuedBytes = 0;
  #consumedCarrierBytes = 0;
  #state: "open" | "ended" | { readonly failure: unknown } = "open";
  #wake: (() => void) | undefined;
  #closed = false;

  constructor(
    handle: Pick<FileHandle, "read">,
    size: number,
    private readonly charge: (bytes: number) => void,
  ) {
    this.#handle = handle;
    this.#size = size;
    const gunzip = createGunzip();
    this.#gunzip = gunzip;
    this.#output = pipeline(
      Readable.from(compressedInput(handle, size)),
      gunzip,
      // The error event below records the failure for the reader.
      () => undefined,
    );
    this.#output.on("data", (chunk: Buffer) => {
      if (this.#state !== "open") return;
      // Charge expansion as zlib produces it, so bytes queued for an idle
      // reader can never exceed the allowance.
      try {
        this.charge(chunk.length);
      } catch (failure: unknown) {
        this.#state = { failure };
        this.#output.destroy();
        this.#notify();
        return;
      }
      this.#queue.push(chunk);
      this.#queuedBytes += chunk.length;
      if (this.#queuedBytes > QUEUE_HIGH_WATER_BYTES) this.#output.pause();
      this.#notify();
    });
    this.#output.once("end", () => {
      if (this.#state === "open") {
        this.#consumedCarrierBytes = this.#gunzip.bytesWritten;
        this.#state = "ended";
      }
      this.#notify();
    });
    this.#output.once("error", (failure: unknown) => {
      if (this.#state === "open") this.#state = { failure };
      this.#notify();
    });
  }

  get position(): number {
    return this.#position;
  }

  async read(length: number, signal?: AbortSignal): Promise<Buffer> {
    const parts: Buffer[] = [];
    let collected = 0;
    while (collected < length) {
      const chunk = await this.#take(length - collected, signal);
      if (chunk === undefined) break;
      parts.push(chunk);
      collected += chunk.length;
    }
    return parts.length === 1 ? parts[0]! : Buffer.concat(parts, collected);
  }

  async skip(length: number, signal?: AbortSignal): Promise<number> {
    let skipped = 0;
    while (skipped < length) {
      const chunk = await this.#take(length - skipped, signal);
      if (chunk === undefined) break;
      skipped += chunk.length;
    }
    return skipped;
  }

  async trailingCarrierNonZero(
    signal?: AbortSignal,
  ): Promise<TrailingCarrierBytes> {
    const offset = this.#consumedCarrierBytes;
    if (offset >= this.#size) return { offset, nonZeroBytes: 0 };
    let nonZeroBytes = 0;
    for (let position = offset, chunks = 0; position < this.#size; chunks++) {
      if (chunks % 64 === 63) await setImmediate();
      assertArtifactReadActive(signal);
      const chunk = await readArtifactFileBytes(
        "tar",
        this.#handle,
        position,
        Math.min(SCAN_CHUNK_BYTES, this.#size - position),
        this.#size,
        signal,
      );
      if (chunk.length === 0) break;
      for (const byte of chunk) if (byte !== 0) nonZeroBytes++;
      position += chunk.length;
    }
    return { offset, nonZeroBytes };
  }

  close(): void {
    this.#closed = true;
    this.#pending = Buffer.alloc(0);
    this.#queue.length = 0;
    this.#queuedBytes = 0;
    this.#output.destroy();
    this.#notify();
  }

  #notify(): void {
    const wake = this.#wake;
    this.#wake = undefined;
    wake?.();
  }

  async #next(signal: AbortSignal | undefined): Promise<Buffer | undefined> {
    for (;;) {
      assertArtifactReadActive(signal);
      const chunk = this.#queue.shift();
      if (chunk !== undefined) {
        this.#queuedBytes -= chunk.length;
        if (this.#queuedBytes <= QUEUE_HIGH_WATER_BYTES / 2)
          this.#output.resume();
        return chunk;
      }
      if (this.#closed) return undefined;
      const state = this.#state;
      if (state === "ended") return undefined;
      if (state !== "open") {
        // Report the failure once; later reads see the end of the stream.
        this.#state = "ended";
        throw gzipStreamFailure(state.failure, this.#position);
      }
      this.#output.resume();
      // Cancellation wakes the wait too; the loop then raises it.
      await new Promise<void>((resolve) => {
        const onAbort = (): void => resolve();
        signal?.addEventListener("abort", onAbort, { once: true });
        this.#wake = () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        };
      });
    }
  }

  async #take(
    length: number,
    signal: AbortSignal | undefined,
  ): Promise<Buffer | undefined> {
    if (this.#pending.length === 0) {
      const next = await this.#next(signal);
      if (next === undefined) return undefined;
      this.#pending = next;
    }
    const chunk = this.#pending.subarray(0, length);
    this.#pending = this.#pending.subarray(chunk.length);
    this.#position += chunk.length;
    return chunk;
  }
}

/** A zlib failure is a fact about the carrier; other failures stay primary. */
const gzipStreamFailure = (cause: unknown, position: number): unknown => {
  const code =
    cause instanceof Error && "code" in cause ? String(cause.code) : undefined;
  if (code === "Z_BUF_ERROR")
    return new TarStreamEnded(
      "truncated",
      `gzip stream ends before its end marker after ${String(position)} decompressed byte(s)`,
    );
  if (code !== undefined && code.startsWith("Z_"))
    return new TarStreamEnded(
      "malformed",
      `gzip stream is malformed after ${String(position)} decompressed byte(s): ${(cause as Error).message}`,
    );
  return cause;
};
