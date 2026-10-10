import type { FileHandle } from "node:fs/promises";
import { PassThrough, type Readable } from "node:stream";
import { once } from "node:events";

import { Reader, ZipReader, type Entry, type FileEntry } from "@zip.js/zip.js";

import {
  ArtifactReaderFailure,
  type ArtifactEntry,
  type ArtifactReader,
} from "./ArtifactReader.js";
import type { ZipPackageFormat } from "../domain/zipPackageFormat.js";
import {
  NonRegularFileReadError,
  openRegularFile,
  sameRegularFileState,
  type StableRegularFileDescriptor,
} from "../filesystem/RegularFile.js";

class NodeFileReader extends Reader<string> {
  #handle: FileHandle | undefined;
  #initPromise: Promise<void> | undefined;
  readonly #ownsHandle: boolean;

  constructor(
    private readonly path: string,
    private readonly maximumReadBytes?: number,
    private readonly admitted?: StableRegularFileDescriptor,
  ) {
    super(path);
    this.#ownsHandle = admitted === undefined;
  }

  override init(): Promise<void> {
    this.#initPromise ??= this.#initialize();
    return this.#initPromise;
  }

  async #initialize(): Promise<void> {
    try {
      this.#handle =
        this.admitted?.handle ??
        (await openRegularFile(this.path, { symlinks: "reject" }));
    } catch (cause: unknown) {
      if (cause instanceof NonRegularFileReadError)
        throw new ArtifactReaderFailure(
          "format",
          `ZIP source is not a regular file: ${this.path}`,
          { cause },
        );
      throw cause;
    }
    const metadata = await this.#handle.stat();
    if (
      !metadata.isFile() ||
      (this.admitted !== undefined &&
        !sameRegularFileState(this.admitted.initial, metadata))
    )
      throw new ArtifactReaderFailure(
        "integrity",
        `ZIP source identity changed before reading: ${this.path}`,
      );
    this.size = metadata.size;
  }

  override async readUint8Array(
    index: number,
    length: number,
  ): Promise<Uint8Array> {
    const handle = this.#handle;
    if (handle === undefined) throw new Error("ZIP reader is not initialized");
    const readBytes = Math.min(length, this.size - index);
    if (
      this.maximumReadBytes !== undefined &&
      readBytes > this.maximumReadBytes
    )
      throw new ArtifactReaderFailure(
        "limit",
        `ZIP metadata read requires ${readBytes} bytes, exceeding the ${this.maximumReadBytes}-byte read budget`,
      );
    const bytes = Buffer.alloc(readBytes);
    const read = await handle.read(bytes, 0, bytes.length, index);
    return bytes.subarray(0, read.bytesRead);
  }

  async closeHandle(): Promise<void> {
    if (!this.#ownsHandle) return;
    await this.#initPromise?.catch(() => undefined);
    if (this.#handle === undefined) return;
    await this.#handle.close();
    this.#handle = undefined;
  }
}

/** Lazy Zip64-capable reader with CRC and overlap verification on every read. */
export class ZipArtifactReader implements ArtifactReader {
  readonly format: ZipPackageFormat;
  readonly #source: NodeFileReader;
  readonly #reader: ZipReader<string>;
  readonly #entries = new Map<string, Entry>();

  /** Optionally bound each metadata read before allocating its backing buffer. */
  constructor(
    path: string,
    format: ZipPackageFormat,
    maximumMetadataReadBytes?: number,
    admitted?: StableRegularFileDescriptor,
  ) {
    this.format = format;
    this.#source = new NodeFileReader(path, maximumMetadataReadBytes, admitted);
    this.#reader = new ZipReader(this.#source, {
      checkSignature: true,
      checkOverlappingEntry: true,
      // REA applies its own provider-neutral path validation in scanReader and
      // must preserve that typed failure instead of zip.js rejecting first.
      filenameValidation: "tolerant",
    });
  }

  async *entries(signal?: AbortSignal): AsyncIterable<ArtifactEntry> {
    for await (const entry of this.#reader.getEntriesGenerator()) {
      abortIfNeeded(signal);
      this.#entries.set(entry.filename, entry);
      const symlink = isSymlink(entry);
      yield {
        path: entry.filename,
        kind: entry.directory ? "directory" : symlink ? "symlink" : "file",
        declaredSize: entry.directory ? null : entry.uncompressedSize,
        compressedSize: entry.directory ? null : entry.compressedSize,
        executable: entry.executable,
        encrypted: entry.encrypted,
        byteOffset: null,
        declaredSha256: null,
        unpacked: false,
        limitations: symlink ? ["Archive symlink target was not read."] : [],
        adapterKey: entry.filename,
      };
    }
  }

  open(entry: ArtifactEntry, signal?: AbortSignal): Promise<Readable> {
    abortIfNeeded(signal);
    const stored = this.#entries.get(entry.adapterKey);
    if (stored === undefined || stored.directory || isSymlink(stored))
      return Promise.reject(
        new ArtifactReaderFailure("format", "ZIP entry is not a regular file"),
      );
    if (stored.encrypted)
      return Promise.reject(
        new ArtifactReaderFailure(
          "unavailable",
          "Encrypted ZIP entry is unsupported",
        ),
      );
    return Promise.resolve(extractStream(stored, signal));
  }

  async close(): Promise<void> {
    // best-effort cleanup: zip-reader close must not mask prior extraction state.
    await this.#reader.close().catch(() => undefined);
    await this.#source.closeHandle();
  }

  provenance(): readonly [] {
    return [];
  }
}

const extractStream = (entry: FileEntry, signal?: AbortSignal): Readable => {
  const output = new PassThrough();
  const controller = new AbortController();
  const onAbort = (): void => {
    controller.abort(signal?.reason);
    // AbortSignal listeners dispatch synchronously, so this destroy wins the race
    // against `getData` rejecting with its own AbortError. That ordering is what
    // keeps the caller-visible failure typed as `cancelled`.
    output.destroy(
      new ArtifactReaderFailure("cancelled", "ZIP operation cancelled"),
    );
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  // `close` covers both a consumer walking away mid-entry and normal completion
  // after `end()`; aborting then is harmless because `getData` has already
  // resolved, and it releases the producer in the abandoned-consumer case.
  output.once("close", () => {
    signal?.removeEventListener("abort", onAbort);
    controller.abort();
  });
  const writable = new WritableStream<Uint8Array>({
    write: async (chunk) => {
      abortIfNeeded(signal);
      if (!output.write(Buffer.from(chunk)))
        await once(output, "drain", { signal: controller.signal });
    },
    close: () => {
      output.end();
    },
    abort: (reason) => {
      output.destroy(toError(reason));
    },
  });
  void entry
    .getData(writable, {
      signal: controller.signal,
      checkSignature: true,
      checkOverlappingEntry: true,
      onprogress: () => abortIfNeeded(signal),
    })
    .catch((cause: unknown) => output.destroy(toError(cause)));
  return output;
};

const isSymlink = (entry: Entry): boolean =>
  entry.unixMode !== undefined && (entry.unixMode & 0o170000) === 0o120000;

const abortIfNeeded = (signal?: AbortSignal): void => {
  if (signal?.aborted === true)
    throw new ArtifactReaderFailure("cancelled", "ZIP operation cancelled");
};

const toError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error("ZIP extraction failed");
