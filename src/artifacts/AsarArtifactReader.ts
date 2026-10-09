import {
  constants,
  createReadStream,
  createWriteStream,
  type ReadStream,
  type Stats,
} from "node:fs";
import {
  lstat,
  mkdtemp,
  open,
  realpath,
  rm,
  type FileHandle,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { isAbsolute, join, relative, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { getRawHeader, listPackage, statFile, uncache } from "@electron/asar";

import {
  ArtifactReaderFailure,
  type ArtifactEntry,
  type ArtifactReader,
} from "./ArtifactReader.js";
import { closeAsarHandle, readValidatedAsarEntry } from "./AsarEntryStream.js";

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
  readonly #entries = new Map<string, AsarEntryState>();
  #snapshot: { readonly path: string; readonly sha256: string } | undefined;
  #snapshotRoot: string | undefined;

  constructor(
    private readonly path: string,
    private readonly openUnpackedFile: OpenAsarUnpackedFile = open,
    private readonly removeSnapshot: (path: string) => Promise<void> = (path) =>
      rm(path, { recursive: true, force: true }),
  ) {}

  async *entries(signal?: AbortSignal): AsyncIterable<ArtifactEntry> {
    let paths: string[];
    try {
      await this.prepareContainer(undefined, signal);
      const snapshotPath = this.#snapshotPath();
      this.#resetArchiveState();
      this.#entries.clear();
      paths = listPackage(snapshotPath, { isPack: false }).sort((left, right) =>
        left.localeCompare(right, "en"),
      );
      this.#headerSize = getRawHeader(snapshotPath).headerSize;
      const archiveMetadata = await lstat(snapshotPath);
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
        metadata = statFile(this.#snapshotPath(), providerPath, false);
      } catch (cause: unknown) {
        throw asarFailure(this.path, `stat ${path}`, cause);
      }
      const kind =
        "files" in metadata
          ? "directory"
          : "link" in metadata
            ? "symlink"
            : "file";
      const entry: ArtifactEntry = {
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
      if (kind === "file" && isAsarFileMetadata(metadata))
        this.#entries.set(providerPath, {
          metadata,
          entry: copyArtifactEntry(entry),
        });
      yield entry;
    }
  }

  async open(entry: ArtifactEntry, signal?: AbortSignal): Promise<Readable> {
    abortIfNeeded(signal);
    const state = this.#entries.get(entry.adapterKey);
    if (state === undefined && entry.kind !== "file")
      throw new ArtifactReaderFailure(
        "format",
        "ASAR entry is not a regular file",
      );
    if (state === undefined)
      throw new ArtifactReaderFailure(
        "integrity",
        `ASAR entry was not produced by this reader: ${entry.path}`,
      );
    if (!sameArtifactEntry(entry, state.entry))
      throw new ArtifactReaderFailure(
        "integrity",
        `ASAR entry metadata changed since inventory: ${state.entry.path}`,
      );
    const { metadata } = state;
    const producedEntry = state.entry;
    if (producedEntry.unpacked) {
      const handle = await this.#openUnpackedEntry(producedEntry);
      try {
        const observed = await handle.stat();
        abortIfNeeded(signal);
        if (!observed.isFile())
          throw new ArtifactReaderFailure(
            "path",
            `ASAR unpacked entry is not a regular file: ${producedEntry.path}`,
          );
      } catch (cause: unknown) {
        await handle.close().catch(() => undefined);
        throw asarFailure(this.path, `read ${producedEntry.path}`, cause);
      }
      const source = handle.createReadStream({
        start: 0,
        autoClose: true,
      });
      return readValidatedAsarEntry(
        source,
        undefined,
        producedEntry.path,
        this.path,
        signal,
      );
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
        `ASAR entry range is outside its container: ${producedEntry.path}`,
      );
    let handle: FileHandle | undefined;
    try {
      const openedHandle = await open(
        this.#snapshotPath(),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      handle = openedHandle;
      const observed = await openedHandle.stat();
      abortIfNeeded(signal);
      if (!observed.isFile() || observed.size !== archiveSize)
        throw new ArtifactReaderFailure(
          "integrity",
          `ASAR container changed before read: ${producedEntry.path}`,
        );
      if (metadata.size === 0) {
        await closeAsarHandle(() => openedHandle.close(), signal);
        handle = undefined;
        return Readable.from([]);
      }
      const source = openedHandle.createReadStream({
        start,
        end: start + metadata.size - 1,
        autoClose: true,
      });
      return readValidatedAsarEntry(
        source,
        metadata.size,
        producedEntry.path,
        this.path,
        signal,
      );
    } catch (cause: unknown) {
      await handle?.close().catch(() => undefined);
      throw asarFailure(this.path, `read ${producedEntry.path}`, cause);
    }
  }

  /** Capture once per reader lifetime; bind all interpretation to these exact bytes. */
  async prepareContainer(
    expectedSha256?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    abortIfNeeded(signal);
    if (this.#snapshot === undefined && this.#snapshotRoot !== undefined)
      await this.close();
    if (this.#snapshot === undefined) {
      try {
        this.#snapshotRoot = await mkdtemp(
          join(tmpdir(), "rea-asar-snapshot-"),
        );
        const snapshotPath = join(this.#snapshotRoot, "container.asar");
        const hash = createHash("sha256");
        const handle = await open(
          this.path,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        const source = handle.createReadStream();
        const digesting = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            hash.update(chunk);
            callback(null, chunk);
          },
        });
        await pipeline(
          source,
          digesting,
          createWriteStream(snapshotPath, { flags: "wx", mode: 0o600 }),
          signal === undefined ? {} : { signal },
        );
        this.#snapshot = { path: snapshotPath, sha256: hash.digest("hex") };
      } catch (cause: unknown) {
        const primary =
          signal?.aborted === true
            ? new ArtifactReaderFailure(
                "cancelled",
                "ASAR operation cancelled",
                { cause },
              )
            : asarFailure(this.path, "snapshot", cause);
        try {
          await this.close();
        } catch (cleanupCause: unknown) {
          throw ArtifactReaderFailure.withCleanup(
            primary,
            ArtifactReaderFailure.cleanupObservation(cleanupCause, this.path),
          );
        }
        throw primary;
      }
    }
    if (
      expectedSha256 !== undefined &&
      this.#snapshot.sha256 !== expectedSha256
    )
      throw new ArtifactReaderFailure(
        "integrity",
        `ASAR container changed before interpretation: ${this.path}`,
      );
  }

  /** Read the same captured container that supplies headers and packed members. */
  async openContainer(signal?: AbortSignal): Promise<ReadStream> {
    await this.prepareContainer(undefined, signal);
    return createReadStream(
      this.#snapshotPath(),
      signal === undefined ? {} : { signal },
    );
  }

  async close(): Promise<void> {
    const root = this.#snapshotRoot;
    if (root !== undefined) {
      try {
        await this.removeSnapshot(root);
      } catch (cause: unknown) {
        throw ArtifactReaderFailure.withCleanup(cause, {
          reason: `Could not remove ASAR snapshot: ${root}`,
          resources: [root],
        });
      }
      this.#snapshotRoot = undefined;
    }
    if (this.#snapshot !== undefined) uncache(this.#snapshot.path);
    this.#snapshot = undefined;
    this.#resetArchiveState();
    this.#entries.clear();
  }

  #snapshotPath(): string {
    if (this.#snapshot === undefined)
      throw new ArtifactReaderFailure(
        "integrity",
        "ASAR snapshot is not available",
      );
    return this.#snapshot.path;
  }

  provenance(): readonly [] {
    return [];
  }

  async #openUnpackedEntry(entry: ArtifactEntry): Promise<UnpackedFileHandle> {
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
      const handle = await this.openUnpackedFile(
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
        openedMetadata.ino !== pathMetadata.ino
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
type AsarEntryState = {
  readonly metadata: AsarFileMetadata;
  readonly entry: ArtifactEntry;
};
type UnpackedFileHandle = {
  stat(): Promise<Stats>;
  close(): Promise<void>;
  createReadStream: FileHandle["createReadStream"];
};
type OpenAsarUnpackedFile = (
  path: string,
  flags: number,
) => Promise<UnpackedFileHandle>;

const copyArtifactEntry = (entry: ArtifactEntry): ArtifactEntry => ({
  ...entry,
  limitations: [...entry.limitations],
  ...(entry.sourceIdentity === undefined
    ? {}
    : { sourceIdentity: { ...entry.sourceIdentity } }),
});

const sameArtifactEntry = (
  entry: ArtifactEntry,
  produced: ArtifactEntry,
): boolean =>
  entry.path === produced.path &&
  entry.kind === produced.kind &&
  entry.declaredSize === produced.declaredSize &&
  entry.compressedSize === produced.compressedSize &&
  entry.executable === produced.executable &&
  entry.encrypted === produced.encrypted &&
  entry.byteOffset === produced.byteOffset &&
  entry.declaredSha256 === produced.declaredSha256 &&
  entry.unpacked === produced.unpacked &&
  entry.adapterKey === produced.adapterKey &&
  entry.limitations.length === produced.limitations.length &&
  entry.limitations.every(
    (limitation, index) => limitation === produced.limitations[index],
  ) &&
  entry.sourceIdentity?.device === produced.sourceIdentity?.device &&
  entry.sourceIdentity?.inode === produced.sourceIdentity?.inode;

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
