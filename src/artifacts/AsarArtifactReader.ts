import { constants, createReadStream } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { Readable } from "node:stream";

import { getRawHeader, listPackage, statFile, uncache } from "@electron/asar";

import {
  ArtifactReaderFailure,
  type ArtifactEntry,
  type ArtifactReader,
} from "./ArtifactReader.js";

/**
 * Official Electron ASAR adapter with range-streamed member reads.
 *
 * An entry marked `unpacked` is metadata, not an integrity exemption: Electron
 * stores its bytes beside the archive in `<archive>.unpacked`, and callers must
 * hash those companion bytes against the archive's declared integrity value.
 */
export class AsarArtifactReader implements ArtifactReader {
  readonly format = "asar" as const;
  #archiveSize: number | undefined;
  #headerSize: number | undefined;
  readonly #entries = new Map<string, AsarFileMetadata>();

  constructor(private readonly path: string) {}

  async *entries(signal?: AbortSignal): AsyncIterable<ArtifactEntry> {
    let paths: string[];
    try {
      // ASAR caches headers by path even after the archive has been replaced.
      this.#resetArchiveState();
      this.#entries.clear();
      uncache(this.path);
      paths = listPackage(this.path, { isPack: false }).sort((left, right) =>
        left.localeCompare(right, "en"),
      );
      this.#headerSize = getRawHeader(this.path).headerSize;
      const archiveMetadata = await lstat(this.path);
      if (!archiveMetadata.isFile() || archiveMetadata.isSymbolicLink())
        throw new ArtifactReaderFailure(
          "format",
          "ASAR container is not a regular file",
        );
      this.#archiveSize = archiveMetadata.size;
    } catch (cause: unknown) {
      throw asarFailure(this.path, "inventory", cause);
    }
    for (const listed of paths) {
      abortIfNeeded(signal);
      // @electron/asar returns paths assembled with the host path module.
      // Keep that spelling for its API calls, but expose archive paths with
      // portable separators. On POSIX, backslashes can be literal filename
      // characters and must remain untouched.
      const path = toArtifactPath(listed);
      if (path.length === 0) continue;
      const providerPath = listed.startsWith(sep)
        ? listed.slice(sep.length)
        : listed;
      let metadata: ReturnType<typeof statFile>;
      try {
        metadata = statFile(this.path, providerPath, false);
      } catch (cause: unknown) {
        throw asarFailure(this.path, `stat ${path}`, cause);
      }
      const kind =
        "files" in metadata
          ? "directory"
          : "link" in metadata
            ? "symlink"
            : "file";
      if (kind === "file" && isAsarFileMetadata(metadata))
        this.#entries.set(providerPath, metadata);
      yield {
        path,
        kind,
        declaredSize: "size" in metadata ? metadata.size : null,
        compressedSize: null,
        executable: "executable" in metadata && metadata.executable,
        encrypted: false,
        byteOffset: null,
        declaredSha256:
          "integrity" in metadata &&
          metadata.integrity.algorithm === "SHA256" &&
          /^[a-f0-9]{64}$/u.test(metadata.integrity.hash)
            ? metadata.integrity.hash
            : null,
        unpacked: "unpacked" in metadata && metadata.unpacked === true,
        limitations:
          kind === "symlink"
            ? ["ASAR symlink target was not followed or disclosed."]
            : [],
        adapterKey: providerPath,
      };
    }
  }

  async open(entry: ArtifactEntry, signal?: AbortSignal): Promise<Readable> {
    abortIfNeeded(signal);
    if (entry.kind !== "file")
      throw new ArtifactReaderFailure(
        "format",
        "ASAR entry is not a regular file",
      );
    const metadata = this.#entries.get(entry.adapterKey);
    if (metadata === undefined)
      throw new ArtifactReaderFailure(
        "integrity",
        `ASAR entry was not produced by this reader: ${entry.path}`,
      );
    if (entry.unpacked) {
      const handle = await this.#openUnpackedEntry(entry, metadata);
      try {
        const observed = await handle.stat();
        if (!observed.isFile() || observed.size !== metadata.size)
          throw new ArtifactReaderFailure(
            "integrity",
            `ASAR unpacked entry changed before read: ${entry.path}`,
            {},
            {
              logicalPath: entry.path,
              declaredSha256: entry.declaredSha256,
              calculatedSha256: null,
              unpacked: true,
            },
          );
      } catch (cause: unknown) {
        await handle.close().catch(() => undefined);
        throw cause;
      }
      if (metadata.size === 0) {
        await handle.close();
        return Readable.from([]);
      }
      const source = handle.createReadStream({
        start: 0,
        end: metadata.size - 1,
        autoClose: true,
      });
      return readExactEntry(source, metadata.size, entry.path, signal);
    }
    const archiveSize = this.#archiveSize;
    const headerSize = this.#headerSize;
    const offset =
      metadata.offset === undefined
        ? undefined
        : parseArchiveOffset(metadata.offset);
    const start =
      offset === undefined || headerSize === undefined
        ? undefined
        : 8 + headerSize + offset;
    if (
      archiveSize === undefined ||
      start === undefined ||
      !Number.isSafeInteger(start) ||
      metadata.size < 0 ||
      !Number.isSafeInteger(metadata.size) ||
      start > archiveSize ||
      metadata.size > archiveSize - start
    )
      throw new ArtifactReaderFailure(
        "format",
        `ASAR entry range is outside its container: ${entry.path}`,
      );
    if (metadata.size === 0) return Readable.from([]);
    const handle = await open(
      this.path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const observed = await handle.stat().catch(async (cause: unknown) => {
      await handle.close().catch(() => undefined);
      throw cause;
    });
    if (!observed.isFile() || observed.size !== archiveSize) {
      await handle.close();
      throw new ArtifactReaderFailure(
        "integrity",
        `ASAR container changed before read: ${entry.path}`,
      );
    }
    const source = handle.createReadStream({
      start,
      end: start + metadata.size - 1,
      autoClose: true,
    });
    return readExactEntry(source, metadata.size, entry.path, signal);
  }

  /** Open raw container bytes to verify the inventory identity before analysis. */
  openContainer(signal?: AbortSignal): Readable {
    abortIfNeeded(signal);
    return createReadStream(this.path, signal === undefined ? {} : { signal });
  }

  close(): Promise<void> {
    uncache(this.path);
    this.#resetArchiveState();
    this.#entries.clear();
    return Promise.resolve();
  }

  provenance(): readonly [] {
    return [];
  }

  async #openUnpackedEntry(
    entry: ArtifactEntry,
    metadata: AsarFileMetadata,
  ): Promise<FileHandle> {
    const unpackedRoot = `${this.path}.unpacked`;
    try {
      const rootMetadata = await lstat(unpackedRoot);
      if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink())
        throw new ArtifactReaderFailure(
          "path",
          "ASAR unpacked companion is not a regular directory",
        );
      const canonicalRoot = await realpath(unpackedRoot);
      const candidate = join(unpackedRoot, entry.adapterKey);
      const canonical = await realpath(candidate);
      const relativePath = relative(canonicalRoot, canonical);
      if (
        relativePath === ".." ||
        relativePath.startsWith(`..${sep}`) ||
        isAbsolute(relativePath)
      )
        throw new ArtifactReaderFailure(
          "path",
          `ASAR unpacked entry escaped its companion directory: ${entry.path}`,
        );
      const pathMetadata = await lstat(candidate);
      if (!pathMetadata.isFile() || pathMetadata.isSymbolicLink())
        throw new ArtifactReaderFailure(
          "path",
          `ASAR unpacked entry is not a regular file: ${entry.path}`,
        );
      const handle = await open(
        canonical,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const openedMetadata = await handle
        .stat()
        .catch(async (cause: unknown) => {
          await handle.close().catch(() => undefined);
          throw cause;
        });
      if (
        !openedMetadata.isFile() ||
        openedMetadata.dev !== pathMetadata.dev ||
        openedMetadata.ino !== pathMetadata.ino ||
        openedMetadata.size !== metadata.size
      ) {
        await handle.close();
        throw new ArtifactReaderFailure(
          "integrity",
          `ASAR unpacked entry changed before read: ${entry.path}`,
          {},
          {
            logicalPath: entry.path,
            declaredSha256: entry.declaredSha256,
            calculatedSha256: null,
            unpacked: true,
          },
        );
      }
      return handle;
    } catch (cause: unknown) {
      if (cause instanceof ArtifactReaderFailure) throw cause;
      if (entry.unpacked && isMissingFile(cause))
        throw new ArtifactReaderFailure(
          "unavailable",
          `ASAR unpacked entry bytes are unavailable: ${entry.path}`,
          { cause },
          {
            logicalPath: entry.path,
            declaredSha256: entry.declaredSha256,
            calculatedSha256: null,
            unpacked: true,
          },
        );
      throw asarFailure(this.path, `read ${entry.path}`, cause);
    }
  }

  #resetArchiveState(): void {
    this.#archiveSize = undefined;
    this.#headerSize = undefined;
  }
}

type AsarFileMetadata = Extract<ReturnType<typeof statFile>, { size: number }>;

const isAsarFileMetadata = (
  metadata: ReturnType<typeof statFile>,
): metadata is AsarFileMetadata =>
  "size" in metadata &&
  typeof metadata.size === "number" &&
  !("files" in metadata) &&
  !("link" in metadata);

const parseArchiveOffset = (value: string): number | undefined => {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) return undefined;
  const offset = Number(value);
  return Number.isSafeInteger(offset) ? offset : undefined;
};

const readExactEntry = (
  source: Readable,
  expectedBytes: number,
  path: string,
  signal?: AbortSignal,
): Readable =>
  Readable.from(
    (async function* () {
      let observedBytes = 0;
      const iterator = source[Symbol.asyncIterator]();
      const onAbort = (): void => {
        source.destroy(
          new ArtifactReaderFailure("cancelled", "ASAR operation cancelled"),
        );
      };
      try {
        while (true) {
          abortIfNeeded(signal);
          const pending = iterator.next();
          signal?.addEventListener("abort", onAbort, { once: true });
          if (signal?.aborted === true) onAbort();
          const next = await pending.finally(() =>
            signal?.removeEventListener("abort", onAbort),
          );
          if (next.done) break;
          const chunk: unknown = next.value;
          if (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array))
            throw new ArtifactReaderFailure(
              "format",
              `ASAR entry did not return bytes: ${path}`,
            );
          observedBytes += Buffer.isBuffer(chunk)
            ? chunk.length
            : chunk.byteLength;
          if (observedBytes > expectedBytes)
            throw new ArtifactReaderFailure(
              "integrity",
              `ASAR entry exceeded its declared size: ${path}`,
            );
          yield chunk;
        }
        if (observedBytes !== expectedBytes)
          throw new ArtifactReaderFailure(
            "integrity",
            `ASAR entry size disagrees with its header: ${path}`,
          );
      } finally {
        signal?.removeEventListener("abort", onAbort);
        await iterator.return?.();
        if (!source.destroyed) source.destroy();
      }
    })(),
  );

const abortIfNeeded = (signal?: AbortSignal): void => {
  if (signal?.aborted === true)
    throw new ArtifactReaderFailure("cancelled", "ASAR operation cancelled");
};

const toArtifactPath = (listed: string): string => {
  const portable = sep === "\\" ? listed.replaceAll("\\", "/") : listed;
  return portable.replace(/^\/+|\/+$/gu, "");
};

const asarFailure = (
  path: string,
  operation: string,
  cause: unknown,
): ArtifactReaderFailure => {
  if (cause instanceof ArtifactReaderFailure) return cause;
  if (isFilesystemFailure(cause))
    return new ArtifactReaderFailure(
      "io",
      `Could not ${operation} ASAR at ${path}: ${cause.message}`,
      { cause },
    );
  return new ArtifactReaderFailure(
    "format",
    `Malformed ASAR during ${operation}: ${path}`,
    { cause },
  );
};

const isFilesystemFailure = (
  cause: unknown,
): cause is NodeJS.ErrnoException & Error =>
  cause instanceof Error &&
  "errno" in cause &&
  typeof cause.errno === "number" &&
  "syscall" in cause &&
  typeof cause.syscall === "string";

const isMissingFile = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  cause.code === "ENOENT";
