import type { FileHandle } from "node:fs/promises";
import { pipeline, type Readable } from "node:stream";
import { createGunzip } from "node:zlib";

import { readFileHandleChunks } from "../../filesystem/readFileHandleChunks.js";
import { readArtifactFileBytes } from "../ArtifactFileRange.js";
import { assertArtifactReadActive } from "../../resources/index.js";

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

  close(): void {
    this.#position = this.size;
  }
}

/**
 * The RFC 1952 decompression of a gzip carrier, pulled on demand. Every
 * decompressed byte is charged before it is used, so expansion stays within
 * the caller's plaintext-work allowance.
 */
export class GzipTarStream implements TarByteStream {
  #position = 0;
  #pending: Buffer = Buffer.alloc(0);
  readonly #output: Readable;
  readonly #chunks: AsyncIterator<Buffer>;
  #ended = false;

  constructor(
    handle: Pick<FileHandle, "read">,
    size: number,
    private readonly charge: (bytes: number) => void,
  ) {
    const gunzip = createGunzip();
    this.#output = pipeline(
      readFileHandleChunks(handle, { start: 0, end: size - 1 }),
      gunzip,
      // Failures surface through the decompressed iterator.
      () => undefined,
    );
    this.#chunks = this.#output[
      Symbol.asyncIterator
    ]() as AsyncIterator<Buffer>;
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

  close(): void {
    this.#ended = true;
    this.#pending = Buffer.alloc(0);
    this.#output.destroy();
  }

  async #take(
    length: number,
    signal: AbortSignal | undefined,
  ): Promise<Buffer | undefined> {
    if (this.#pending.length === 0) {
      if (this.#ended) return undefined;
      assertArtifactReadActive(signal);
      let next: IteratorResult<Buffer>;
      try {
        next = await this.#chunks.next();
      } catch (cause: unknown) {
        this.#ended = true;
        throw gzipStreamFailure(cause, this.#position);
      }
      assertArtifactReadActive(signal);
      if (next.done === true) {
        this.#ended = true;
        return undefined;
      }
      this.charge(next.value.length);
      this.#pending = next.value;
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
