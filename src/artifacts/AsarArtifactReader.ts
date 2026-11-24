import { appendCallerPath } from "../filesystem/callerPath.js";
import { localPathStringSchema } from "../domain/localPath.js";
import type { AsarHeaderAdmission } from "../config/asarHeaderAdmission.js";
import { artifactIntegrityDetails } from "../domain/artifactIntegrity.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  assertStableRegularFileIdentity,
  RegularFileChangedError,
  type StableRegularFileDescriptor,
} from "../filesystem/RegularFile.js";
import { constants, type Stats } from "node:fs";
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
import { Readable } from "node:stream";

import {
  ArtifactEntryContentUnavailable,
  ArtifactReaderFailure,
  artifactFormatFailure,
  malformedArtifact,
  truncatedArtifact,
  copyArtifactEntry,
  sameArtifactEntry,
  type ArtifactEntry,
  type ArtifactReader,
  type ArtifactTraversalOptions,
  readArtifactFileChunks,
  assertArtifactSelectedSource,
  admitAsarHeader,
  readAsarHeader,
  type AsarHeaderExtents,
} from "../resources/index.js";
import {
  readValidatedAsarEntry,
  readValidatedAsarRange,
} from "./AsarEntryStream.js";
import { OwnedFileHandle } from "../filesystem/OwnedFileHandle.js";
import type { FileHandleChunkStream } from "../filesystem/readFileHandleChunks.js";
import {
  assertAsarReadActive,
  asarCancellationFailure,
  asarFailure,
} from "./AsarFailure.js";
import { readAsarListing, type AsarListedEntry } from "./AsarListing.js";

const SNAPSHOT_CHUNK_BYTES = 256 * 1024;

/**
 * Electron ASAR reader with strict header decoding and range-streamed member reads.
 *
 * An entry marked `unpacked` is metadata, not an integrity exemption: Electron
 * stores its bytes beside the archive in `<archive>.unpacked`, and callers must
 * hash those companion bytes against the archive's declared integrity value.
 */
export class AsarArtifactReader implements ArtifactReader {
  readonly format = "asar" as const;
  #extents: AsarHeaderExtents | undefined;
  #selectedCanonicalSource: string | undefined;
  readonly #entries = new Map<string, AsarEntryState>();
  readonly #ownedHandles = new Map<SharedAsarFileHandle, OwnedAsarHandle>();
  #snapshot:
    | {
        readonly path: string;
        readonly sha256: string;
        readonly bytes: number;
      }
    | undefined;
  #snapshotHandle: SharedAsarFileHandle | undefined;
  #snapshotStatsChecked = false;
  #snapshotRoot: string | undefined;
  #snapshotOperation: Promise<void> = Promise.resolve();
  #snapshotGeneration = 0;

  constructor(
    private readonly path: string,
    private readonly options: AsarArtifactReaderOptions = {},
  ) {}

  async *entries(
    signal?: AbortSignal,
    options?: ArtifactTraversalOptions,
  ): AsyncIterable<ArtifactEntry> {
    const generation = this.#snapshotGeneration;
    let paths: readonly AsarListedEntry[];
    try {
      await this.prepareContainer(undefined, signal);
      paths = await this.#withSnapshotOperation(async () => {
        const snapshotPath = this.#snapshotPath();
        this.#resetArchiveState();
        this.#entries.clear();
        const admitted = await this.#admitHeader(snapshotPath, signal);
        this.#extents = {
          archiveBytes: admitted.archiveBytes,
          headerBytes: admitted.headerBytes,
          jsonBytes: admitted.jsonBytes,
        };
        assertAsarReadActive(signal);
        try {
          return await readAsarListing(
            admitted.header,
            signal,
            this.options.headerAdmission?.listing,
          );
        } catch (cause: unknown) {
          // Listing names members relative to this archive; keep which archive.
          if (!(cause instanceof ArtifactReaderFailure)) throw cause;
          if (cause.parseFailure !== undefined)
            throw artifactFormatFailure(
              {
                ...cause.parseFailure,
                detail: `${cause.parseFailure.detail} in ${this.path}`,
              },
              { cause },
            );
          if (cause.reason === "path")
            throw new ArtifactReaderFailure(
              "path",
              `${cause.message} in ${this.path}`,
              { cause },
            );
          throw cause;
        }
      }, signal);
    } catch (cause: unknown) {
      // A typed analysis failure already owns its public classification.
      if (cause instanceof AnalysisError) throw cause;
      throw asarFailure(this.path, "inventory", cause);
    }
    for (const facts of paths) {
      this.#assertInventoryActive(generation, signal);
      const { path, kind } = facts;
      const providerPath = path.split("/").join(sep);
      const entry: ArtifactEntry = {
        path,
        kind,
        declaredSize: facts.size,
        compressedSize: null,
        executable: facts.executable,
        encrypted: false,
        byteOffset: null,
        declaredIntegrity: facts.declaredIntegrity,
        unpacked: facts.unpacked,
        limitations: [
          ...facts.limitations,
          ...(kind === "symlink"
            ? ["ASAR symlink target was not followed or disclosed."]
            : []),
        ],
        adapterKey: providerPath,
      };
      if (facts.kind === "file")
        this.#entries.set(providerPath, {
          facts,
          entry: copyArtifactEntry(entry),
        });
      yield entry;
    }
    this.#assertInventoryActive(generation, signal);
    // The listing names every member record the header declares.
    options?.onCoverage?.({ status: "complete", limitations: [] });
  }

  #assertInventoryActive(generation: number, signal?: AbortSignal): void {
    assertAsarReadActive(signal);
    if (generation !== this.#snapshotGeneration)
      throw new ArtifactReaderFailure(
        "unavailable",
        "ASAR inventory snapshot was closed",
      );
  }

  async #admitHeader(snapshotPath: string, signal?: AbortSignal) {
    const headerHandle = await this.#ensureSnapshotHandle(signal);
    let admission:
      | {
          readonly ok: true;
          readonly value: Awaited<ReturnType<typeof admitAsarHeader>> & {
            readonly header: unknown;
          };
        }
      | { readonly ok: false; readonly cause: unknown };
    try {
      const extents = await admitAsarHeader(
        headerHandle,
        signal,
        this.options.headerAdmission,
      );
      admission = {
        ok: true,
        value: {
          ...extents,
          header: await readAsarHeader(headerHandle, extents, signal),
        },
      };
    } catch (cause: unknown) {
      admission = { ok: false, cause };
    }
    if (!admission.ok) {
      try {
        await this.#closeOwnedHandle(headerHandle);
      } catch (cleanupCause: unknown) {
        throw ArtifactReaderFailure.withCleanup(
          admission.cause,
          ArtifactReaderFailure.cleanupObservation(cleanupCause, snapshotPath),
        );
      }
      throw admission.cause;
    }
    this.#snapshotStatsChecked = true;
    return admission.value;
  }

  async open(entry: ArtifactEntry, signal?: AbortSignal): Promise<Readable> {
    return this.#withSnapshotOperation(
      () => this.#openEntry(entry, signal),
      signal,
    );
  }

  async #openEntry(
    entry: ArtifactEntry,
    signal?: AbortSignal,
  ): Promise<Readable> {
    assertAsarReadActive(signal);
    const state = this.#entries.get(entry.adapterKey);
    if (state === undefined && entry.kind !== "file")
      throw new ArtifactReaderFailure(
        "path",
        "ASAR entry is not a regular file",
      );
    if (state === undefined)
      throw new ArtifactReaderFailure(
        "integrity",
        `ASAR entry was not produced by this reader: ${entry.path}`,
        { integrityCheck: "foreign-entry" },
      );
    if (!sameArtifactEntry(entry, state.entry))
      throw new ArtifactReaderFailure(
        "integrity",
        `ASAR entry metadata changed since inventory: ${state.entry.path}`,
        { integrityCheck: "entry-metadata" },
      );
    if (state.entry.unpacked)
      return this.#openUnpackedStream(state.entry, signal);
    return this.#openPackedStream(state, signal);
  }

  async #openPackedStream(
    state: AsarEntryState,
    signal?: AbortSignal,
  ): Promise<Readable> {
    const { facts, entry: producedEntry } = state;
    const archiveSize = this.#extents?.archiveBytes;
    const headerSize = this.#extents?.headerBytes;
    const offset = facts.packedOffset;
    const start =
      offset === undefined || headerSize === undefined
        ? undefined
        : 8 + headerSize + offset;
    if (facts.size === null)
      throw new ArtifactEntryContentUnavailable(
        `ASAR entry declares no readable size: ${producedEntry.path}`,
        "ASAR packed entry bytes were not read because its declared size cannot bound them; no content hash or child artifact was produced.",
        undefined,
        artifactIntegrityDetails(
          producedEntry.path,
          producedEntry.declaredIntegrity,
          null,
          false,
        ),
      );
    // An absent, negative, padded or unsafe offset declaration is malformed;
    // only a valid range that runs past the archive is truncated.
    if (
      archiveSize === undefined ||
      start === undefined ||
      !Number.isSafeInteger(start)
    )
      throw malformedArtifact(
        "asar",
        `ASAR entry declares an invalid offset: ${producedEntry.path}`,
        { field: "offset" },
      );
    if (start > archiveSize || facts.size > archiveSize - start)
      throw truncatedArtifact(
        "asar",
        `ASAR entry range is outside its container: ${producedEntry.path}`,
        {
          offset: start,
          field: "offset",
          availableBytes: Math.max(0, archiveSize - start),
          requiredBytes: facts.size,
        },
      );
    const snapshotPath = this.#snapshotPath();
    if (facts.size === 0) return Readable.from([]);
    let openedNew = false;
    let handle: SharedAsarFileHandle | undefined;
    try {
      const needsOpen =
        this.#snapshotHandle === undefined ||
        !this.#ownedHandles.has(this.#snapshotHandle);
      const openedHandle = await this.#ensureSnapshotHandle(signal);
      openedNew = needsOpen;
      handle = openedHandle;
      if (!this.#snapshotStatsChecked) {
        const observed = await openedHandle.stat();
        assertAsarReadActive(signal);
        if (!observed.isFile() || observed.size !== archiveSize)
          throw new ArtifactReaderFailure(
            "integrity",
            `ASAR container changed before read: ${producedEntry.path}`,
            { integrityCheck: "container-identity" },
          );
        this.#snapshotStatsChecked = true;
      }
      const output = readValidatedAsarRange(
        openedHandle,
        start,
        facts.size,
        producedEntry.path,
        this.path,
        signal,
      );
      this.#trackOwnedStream(openedHandle, output);
      handle = undefined;
      return output;
    } catch (cause: unknown) {
      const failure = asarFailure(
        this.path,
        `read ${producedEntry.path}`,
        cause,
      );
      if (handle !== undefined && openedNew) {
        try {
          await this.#closeOwnedHandle(handle);
        } catch (cleanupCause: unknown) {
          throw ArtifactReaderFailure.withCleanup(
            failure,
            ArtifactReaderFailure.cleanupObservation(
              cleanupCause,
              snapshotPath,
            ),
          );
        }
      }
      throw failure;
    }
  }

  /** Capture once per reader lifetime; bind all interpretation to these exact bytes. */
  async prepareContainer(
    expectedSha256?: string,
    signal?: AbortSignal,
    expectedBytes?: number,
  ): Promise<void> {
    await this.#withSnapshotOperation(async () => {
      assertAsarReadActive(signal);
      await this.#validateSelectedArchive();
      if (this.#snapshot === undefined && this.#snapshotRoot !== undefined)
        await this.#closeSnapshot();
      if (this.#snapshot === undefined) await this.#captureSnapshot(signal);
      if (
        (expectedSha256 !== undefined &&
          this.#snapshot?.sha256 !== expectedSha256) ||
        (expectedBytes !== undefined && this.#snapshot?.bytes !== expectedBytes)
      )
        throw new ArtifactReaderFailure(
          "integrity",
          `ASAR container changed before interpretation: ${this.path}`,
          { integrityCheck: "container-identity" },
        );
    }, signal);
  }

  /** Read the same captured container that supplies headers and packed members. */
  async openContainer(signal?: AbortSignal): Promise<Readable> {
    await this.prepareContainer(undefined, signal);
    return this.#withSnapshotOperation(async () => {
      assertAsarReadActive(signal);
      const handle = await this.#ensureSnapshotHandle(signal);
      return this.#ownedReadStream(handle, { signal, releaseOnClose: false });
    }, signal);
  }

  async close(): Promise<void> {
    this.#snapshotGeneration += 1;
    await this.#withSnapshotOperation(() => this.#closeSnapshot());
  }

  async #captureSnapshot(signal?: AbortSignal): Promise<void> {
    const admitted =
      this.options.openFile === undefined ? this.options.admitted : undefined;
    let inputHandle: SharedAsarFileHandle | undefined;
    let snapshotWriteHandle: FileHandle | undefined;
    let snapshotPath: string | undefined;
    try {
      this.#snapshotRoot = await mkdtemp(join(tmpdir(), "rea-asar-snapshot-"));
      snapshotPath = join(this.#snapshotRoot, "container.asar");
      const hash = createHash("sha256");
      const readHandle =
        admitted !== undefined
          ? admitted.handle
          : (inputHandle = await this.#openOwned(
              this.path,
              constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
            ));
      snapshotWriteHandle = await open(
        snapshotPath,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      this.#adoptHandle(snapshotWriteHandle, snapshotPath);
      const bytes = await this.#copyToSnapshot(
        readHandle,
        snapshotWriteHandle,
        hash,
        admitted,
        signal,
      );
      const completedWrite = snapshotWriteHandle;
      snapshotWriteHandle = undefined;
      await this.#closeOwnedHandle(completedWrite);
      if (inputHandle !== undefined) {
        const completedInput = inputHandle;
        inputHandle = undefined;
        await this.#closeOwnedHandle(completedInput);
      }
      assertAsarReadActive(signal);
      this.#snapshot = {
        path: snapshotPath,
        sha256: hash.digest("hex"),
        bytes,
      };
    } catch (cause: unknown) {
      let failure = asarFailure(this.path, "snapshot", cause);
      for (const [pending, label] of [
        [snapshotWriteHandle, snapshotPath ?? this.path] as const,
        [inputHandle, this.path] as const,
      ]) {
        if (pending === undefined) continue;
        try {
          await this.#closeOwnedHandle(pending);
        } catch (cleanupCause: unknown) {
          failure = ArtifactReaderFailure.withCleanup(
            failure,
            ArtifactReaderFailure.cleanupObservation(cleanupCause, label),
          );
        }
      }
      try {
        if (this.#ownedHandles.size === 0) await this.#closeSnapshot();
      } catch (cleanupCause: unknown) {
        throw ArtifactReaderFailure.withCleanup(
          failure,
          ArtifactReaderFailure.cleanupObservation(
            cleanupCause,
            this.#snapshotRoot ?? this.path,
          ),
        );
      }
      throw failure;
    }
  }

  async #copyToSnapshot(
    readHandle: Pick<FileHandle, "read">,
    writeHandle: FileHandle,
    hash: ReturnType<typeof createHash>,
    admitted: StableRegularFileDescriptor | undefined,
    signal?: AbortSignal,
  ): Promise<number> {
    const buffer = Buffer.allocUnsafe(SNAPSHOT_CHUNK_BYTES);
    let position = 0;
    const limit = admitted?.initial.size;
    for (;;) {
      assertAsarReadActive(signal);
      const toRead =
        limit === undefined
          ? buffer.length
          : Math.min(buffer.length, limit - position + 1);
      if (toRead <= 0) break;
      const { bytesRead } = await readHandle.read(buffer, 0, toRead, position);
      if (limit !== undefined && position + bytesRead > limit)
        throw new ArtifactReaderFailure(
          "integrity",
          `ASAR container changed before interpretation: ${this.path}`,
          { integrityCheck: "container-identity" },
        );
      assertAsarReadActive(signal);
      if (bytesRead === 0) break;
      const chunk =
        bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead);
      hash.update(chunk);
      await writeHandleAll(writeHandle, chunk);
      position += bytesRead;
    }
    if (admitted !== undefined) {
      if (position !== admitted.initial.size)
        throw new ArtifactReaderFailure(
          "integrity",
          `ASAR container changed before interpretation: ${this.path}`,
          { integrityCheck: "container-identity" },
        );
      try {
        await assertStableRegularFileIdentity(
          admitted.handle,
          this.path,
          admitted.initial,
          {
            symlinks: "reject",
            ...(signal === undefined ? {} : { signal }),
          },
        );
      } catch (cause: unknown) {
        if (cause instanceof RegularFileChangedError)
          throw new ArtifactReaderFailure(
            "integrity",
            `ASAR container changed before interpretation: ${this.path}`,
            {
              cause: cause.cause ?? cause,
              integrityCheck: "container-identity",
            },
          );
        throw cause;
      }
    }
    return position;
  }

  async #closeSnapshot(): Promise<void> {
    await this.#closeOwnedHandles();
    const root = this.#snapshotRoot;
    if (root !== undefined) {
      try {
        await (this.options.removeSnapshot ?? defaultRemoveSnapshot)(root);
        if (this.#snapshotRoot === root) this.#snapshotRoot = undefined;
      } catch (cause: unknown) {
        throw ArtifactReaderFailure.withCleanup(cause, {
          reason: `Could not remove ASAR snapshot: ${root}`,
          resources: [root],
        });
      }
    }
    if (root === undefined || this.#snapshotRoot === undefined) {
      this.#snapshot = undefined;
      this.#snapshotHandle = undefined;
      this.#snapshotStatsChecked = false;
      this.#resetArchiveState();
      this.#entries.clear();
    }
  }

  async #withSnapshotOperation<Value>(
    operation: () => Promise<Value>,
    signal?: AbortSignal,
  ): Promise<Value> {
    const previous = this.#snapshotOperation;
    let release!: () => void;
    this.#snapshotOperation = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await waitForOperation(previous, signal);
    } catch (cause: unknown) {
      void previous.then(release, release);
      throw cause;
    }
    try {
      assertAsarReadActive(signal);
      return await operation();
    } finally {
      release();
    }
  }

  #snapshotPath(): string {
    // Preparation captured a snapshot; only a close queued between preparation
    // and this operation removes it, as `#assertInventoryActive` reports.
    if (this.#snapshot === undefined)
      throw new ArtifactReaderFailure(
        "unavailable",
        "ASAR snapshot was closed",
      );
    return this.#snapshot.path;
  }

  provenance(): readonly [] {
    return [];
  }

  /** A selected companion cannot silently migrate to another packed target. */
  async #validateSelectedArchive(): Promise<void> {
    const selected = this.options.selectedPath;
    if (selected === undefined) return;
    // The packed pathname is fixed for this reader; member checks only need
    // to re-observe the caller's independently selected alias.
    this.#selectedCanonicalSource ??= await realpath(this.path);
    await assertArtifactSelectedSource(this.#selectedCanonicalSource, selected);
  }

  async #openUnpackedStream(
    entry: ArtifactEntry,
    signal?: AbortSignal,
  ): Promise<Readable> {
    // Header names retain UTF-16 identity; filesystem encoding may replace
    // unpaired surrogates and select a different companion. Packed members
    // need no filesystem name and remain readable under their original names.
    if (!localPathStringSchema.safeParse(entry.adapterKey).success)
      throw new ArtifactEntryContentUnavailable(
        `ASAR unpacked member path cannot be represented without replacement: ${JSON.stringify(entry.path)}`,
        "ASAR unpacked member path cannot be represented without replacement on the local filesystem; companion bytes were not read and no content hash or child artifact was produced.",
      );
    const unpackedRoot = `${this.options.selectedPath ?? this.path}.unpacked`;
    let handle: SharedAsarFileHandle | undefined;
    try {
      await this.#validateSelectedArchive();
      const rootMetadata = await lstat(unpackedRoot);
      if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink())
        throw new ArtifactReaderFailure(
          "path",
          "ASAR unpacked companion is not a regular directory",
        );
      const canonicalRoot = await realpath(unpackedRoot);
      const candidate = appendCallerPath(unpackedRoot, entry.adapterKey);
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
      handle = await (this.options.openUnpackedFile ?? open)(
        canonical,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const openedHandle = handle;
      this.#adoptHandle(openedHandle, canonical);
      const openedMetadata = await openedHandle.stat();
      if (
        !openedMetadata.isFile() ||
        openedMetadata.dev !== pathMetadata.dev ||
        openedMetadata.ino !== pathMetadata.ino
      ) {
        throw new ArtifactReaderFailure(
          "integrity",
          `ASAR unpacked entry changed before read: ${entry.path}`,
          { integrityCheck: "unpacked-entry-identity" },
          artifactIntegrityDetails(
            entry.path,
            entry.declaredIntegrity,
            null,
            true,
          ),
        );
      }
      assertAsarReadActive(signal);
      const source = this.#ownedReadStream(openedHandle, { start: 0, signal });
      handle = undefined;
      const output = readValidatedAsarEntry(
        source,
        undefined,
        entry.path,
        this.path,
        signal,
      );
      this.#trackOwnedStream(openedHandle, output);
      return output;
    } catch (cause: unknown) {
      let failure = asarUnpackedEntryFailure(this.path, entry, cause);
      if (handle !== undefined && this.#ownedHandles.has(handle)) {
        try {
          await this.#closeOwnedHandle(handle);
        } catch (cleanupCause: unknown) {
          failure = ArtifactReaderFailure.withCleanup(
            failure,
            ArtifactReaderFailure.cleanupObservation(
              cleanupCause,
              this.#ownedHandles.get(handle)?.path ?? entry.path,
            ),
          );
        }
      }
      throw failure;
    }
  }

  async #ensureSnapshotHandle(
    signal?: AbortSignal,
  ): Promise<SharedAsarFileHandle> {
    assertAsarReadActive(signal);
    if (
      this.#snapshotHandle !== undefined &&
      this.#ownedHandles.has(this.#snapshotHandle)
    ) {
      return this.#snapshotHandle;
    }
    const snapshotPath = this.#snapshotPath();
    const handle = await this.#openOwned(
      snapshotPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      assertAsarReadActive(signal);
    } catch (cause: unknown) {
      try {
        await this.#closeOwnedHandle(handle);
      } catch (cleanupCause: unknown) {
        throw ArtifactReaderFailure.withCleanup(
          asarFailure(this.path, "read", cause),
          ArtifactReaderFailure.cleanupObservation(cleanupCause, snapshotPath),
        );
      }
      throw cause;
    }
    this.#snapshotHandle = handle;
    this.#snapshotStatsChecked = false;
    return handle;
  }

  async #closeOwnedHandle(handle: SharedAsarFileHandle): Promise<void> {
    const owned = this.#ownedHandles.get(handle);
    if (owned === undefined) return;
    for (const stream of [...owned.streams]) {
      if (!stream.destroyed) stream.destroy();
    }
    try {
      await owned.owner.close();
    } catch (cause: unknown) {
      throw ArtifactReaderFailure.withCleanup(
        cause,
        ArtifactReaderFailure.cleanupObservation(cause, owned.path),
      );
    }
    this.#ownedHandles.delete(handle);
    if (this.#snapshotHandle === handle) {
      this.#snapshotHandle = undefined;
      this.#snapshotStatsChecked = false;
    }
  }

  async #closeOwnedHandles(): Promise<void> {
    let failure: ArtifactReaderFailure | undefined;
    for (const [handle, owned] of [...this.#ownedHandles]) {
      try {
        await this.#closeOwnedHandle(handle);
      } catch (cause: unknown) {
        failure = ArtifactReaderFailure.withCleanup(
          failure ?? cause,
          ArtifactReaderFailure.cleanupObservation(cause, owned.path),
        );
      }
    }
    if (failure !== undefined) throw failure;
  }

  async #openOwned(path: string, flags: number): Promise<SharedAsarFileHandle> {
    const handle = await (this.options.openFile ?? open)(path, flags);
    this.#adoptHandle(handle, path);
    return handle;
  }

  #adoptHandle(handle: SharedAsarFileHandle, path: string): void {
    this.#ownedHandles.set(handle, {
      path,
      owner: new OwnedFileHandle(handle),
      streams: new Set(),
    });
  }

  #ownedReadStream(
    handle: SharedAsarFileHandle,
    options: {
      readonly start?: number;
      readonly end?: number;
      readonly signal?: AbortSignal | undefined;
      readonly releaseOnClose?: boolean;
    },
  ): FileHandleChunkStream {
    const { releaseOnClose, ...readOptions } = options;
    const source = readArtifactFileChunks(handle, readOptions);
    this.#trackOwnedStream(handle, source);
    if (releaseOnClose !== false)
      source.once("close", () => {
        void this.#closeOwnedHandle(handle).catch(() => undefined);
      });
    return source;
  }

  #trackOwnedStream(handle: SharedAsarFileHandle, stream: Readable): void {
    const owned = this.#ownedHandles.get(handle);
    if (owned === undefined)
      throw new ArtifactReaderFailure("integrity", "ASAR handle has no owner", {
        integrityCheck: "reader-ownership",
      });
    owned.streams.add(stream);
    stream.once("close", () => {
      owned.streams.delete(stream);
    });
  }

  #resetArchiveState(): void {
    this.#extents = undefined;
  }
}

type AsarEntryState = {
  readonly facts: Extract<AsarListedEntry, { readonly kind: "file" }>;
  readonly entry: ArtifactEntry;
};
type SharedAsarFileHandle = Pick<FileHandle, "fd" | "read" | "close"> & {
  stat(): Promise<Stats>;
};
type OpenAsarFile = (
  path: string,
  flags: number,
) => Promise<SharedAsarFileHandle>;
type OwnedAsarHandle = {
  readonly path: string;
  readonly owner: OwnedFileHandle<SharedAsarFileHandle>;
  readonly streams: Set<Readable>;
};
export type AsarArtifactReaderOptions = {
  /** Header/index admission resolved by the caller's composition root; default otherwise. */
  readonly headerAdmission?: AsarHeaderAdmission;
  /** Companion selected by the caller archive spelling, independently of packed identity. */
  readonly selectedPath?: string;
  /** Pre-opened source descriptor admitted during classification to avoid re-opening. */
  readonly admitted?: StableRegularFileDescriptor;
  readonly openFile?: OpenAsarFile;
  readonly openUnpackedFile?: OpenAsarFile;
  readonly removeSnapshot?: (path: string) => Promise<void>;
};

const writeHandleAll = async (
  handle: FileHandle,
  chunk: Uint8Array,
): Promise<void> => {
  let offset = 0;
  while (offset < chunk.length) {
    const { bytesWritten } = await handle.write(
      chunk,
      offset,
      chunk.length - offset,
    );
    if (bytesWritten <= 0)
      throw new ArtifactReaderFailure(
        "io",
        "Short write while capturing ASAR snapshot",
      );
    offset += bytesWritten;
  }
};

const defaultRemoveSnapshot = (path: string): Promise<void> =>
  rm(path, { recursive: true, force: true });

const asarUnpackedEntryFailure = (
  archivePath: string,
  entry: ArtifactEntry,
  cause: unknown,
): ArtifactReaderFailure => {
  if (cause instanceof ArtifactReaderFailure) return cause;
  if (entry.unpacked && isMissingFile(cause))
    return new ArtifactEntryContentUnavailable(
      `ASAR unpacked entry bytes are unavailable: ${entry.path}`,
      "ASAR unpacked companion bytes were unavailable; no content hash or child artifact was produced.",
      { cause },
      artifactIntegrityDetails(entry.path, entry.declaredIntegrity, null, true),
    );
  return asarFailure(archivePath, `read ${entry.path}`, cause);
};

const waitForOperation = async (
  operation: Promise<void>,
  signal?: AbortSignal,
): Promise<void> => {
  if (signal === undefined) return operation;
  assertAsarReadActive(signal);
  await new Promise<void>((resolve, reject) => {
    const removeAbortListener = (): void =>
      signal.removeEventListener("abort", onAbort);
    const onAbort = (): void => {
      removeAbortListener();
      reject(asarCancellationFailure(signal.reason));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      () => {
        removeAbortListener();
        resolve();
      },
      (cause: unknown) => {
        removeAbortListener();
        reject(cause);
      },
    );
  });
};

const isMissingFile = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  cause.code === "ENOENT";
