import { open, type FileHandle } from "node:fs/promises";
import { PassThrough, type Readable } from "node:stream";
import { once } from "node:events";

import { Reader, ZipReader, type Entry, type FileEntry } from "@zip.js/zip.js";

import {
  ArtifactReaderFailure,
  type ArtifactEntry,
  type ArtifactReader,
} from "./ArtifactReader.js";
import type { ZipPackageFormat } from "../domain/zipPackageFormat.js";

class NodeFileReader extends Reader<string> {
  #handle: FileHandle | undefined;

  constructor(private readonly path: string) {
    super(path);
  }

  override async init(): Promise<void> {
    this.#handle = await open(this.path, "r");
    this.size = (await this.#handle.stat()).size;
  }

  override async readUint8Array(
    index: number,
    length: number,
  ): Promise<Uint8Array> {
    const handle = this.#handle;
    if (handle === undefined) throw new Error("ZIP reader is not initialized");
    const bytes = Buffer.alloc(Math.min(length, this.size - index));
    const read = await handle.read(bytes, 0, bytes.length, index);
    return bytes.subarray(0, read.bytesRead);
  }

  async closeHandle(): Promise<void> {
    await this.#handle?.close();
    this.#handle = undefined;
  }
}

/** Lazy Zip64-capable reader with CRC and overlap verification on every read. */
export class ZipArtifactReader implements ArtifactReader {
  readonly format: ZipPackageFormat;
  readonly #source: NodeFileReader;
  readonly #reader: ZipReader<string>;
  readonly #entries = new Map<string, Entry>();

  constructor(path: string, format: ZipPackageFormat) {
    this.format = format;
    this.#source = new NodeFileReader(path);
    this.#reader = new ZipReader(this.#source, {
      checkSignature: true,
      checkOverlappingEntry: true,
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
    await this.#reader.close().catch(() => undefined);
    await this.#source.closeHandle();
  }

  provenance(): readonly [] {
    return [];
  }
}

const extractStream = (entry: FileEntry, signal?: AbortSignal): Readable => {
  const output = new PassThrough();
  const writable = new WritableStream<Uint8Array>({
    write: async (chunk) => {
      abortIfNeeded(signal);
      if (!output.write(Buffer.from(chunk))) await once(output, "drain");
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
