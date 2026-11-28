import {
  DEFAULT_TAR_READER_LIMITS,
  type TarReaderLimits,
} from "../../domain/artifactReaderLimits.js";
import type { FileHandle } from "node:fs/promises";
import type { Readable } from "node:stream";
import { setImmediate } from "node:timers/promises";

import { artifactExpansionBudgetBytes } from "../../domain/artifactExpansionBudget.js";
import { Budget } from "../../domain/budget.js";
import type { TarMetadata } from "../../domain/formatMetadata/packageAndGameMetadata.js";
import type { ArtifactFormatMetadata } from "../../domain/artifactFormatMetadata.js";
import { hasGzipMagic } from "../../domain/tarFormat.js";
import type { StableRegularFileDescriptor } from "../../filesystem/RegularFile.js";
import {
  ArtifactFileSource,
  ArtifactReaderFailure,
  ArtifactResourceScope,
  artifactReaderLimitFailure,
  assertArtifactReadActive,
  assertProducedEntry,
  copyArtifactEntry,
  type ArtifactEntry,
  type ArtifactReader,
  type ArtifactReaderTraversal,
  type ArtifactTraversalOmission,
  type ArtifactTraversalOptions,
} from "../../resources/index.js";
import { ArtifactPreparation } from "../ArtifactPreparation.js";
import { readArtifactFileBytes } from "../ArtifactFileRange.js";
import { OwnedAsyncArtifactStreams } from "../OwnedAsyncArtifactStreams.js";
import {
  GzipTarStream,
  PlainTarStream,
  TarStreamEnded,
  type TarByteStream,
} from "./TarByteStream.js";
import { walkTar, type TarMember } from "./TarWalk.js";

const CHUNK_BYTES = 64 * 1024;

type TarEntry = ArtifactEntry & {
  readonly formatMetadata: Extract<
    ArtifactFormatMetadata,
    { kind: "tar-entry" }
  >;
};

interface TarEntryState {
  readonly entry: TarEntry;
  readonly member: TarMember;
}

interface PreparedTar {
  readonly entries: ReadonlyMap<string, TarEntryState>;
  readonly omissions: readonly ArtifactTraversalOmission[];
  readonly coverage: ArtifactReaderTraversal;
  readonly metadata: TarMetadata;
}

/**
 * POSIX ustar, pax and GNU tar, stored or gzip-compressed. Preparation walks
 * every header once. Stored members are carrier ranges. Gzip members are
 * read by decompressing forward from the start; an idle decompression is
 * kept so members opened in archive order cost one pass. Every decompressed
 * byte and every stored member read is charged to the plaintext-work allowance.
 */
export class TarArtifactReader implements ArtifactReader {
  readonly format = "tar" as const;
  readonly #scope = new ArtifactResourceScope();
  readonly #streams = new OwnedAsyncArtifactStreams(
    this.#scope,
    "tar",
    CHUNK_BYTES,
  );
  readonly #source: ArtifactFileSource;
  readonly #preparation = new ArtifactPreparation();
  readonly #expandedBytes: number | undefined;
  #prepared: PreparedTar | undefined;
  #compression: TarMetadata["compression"] = "none";
  /** Plaintext bytes allowed across gzip decompression and stored member reads. */
  #inflation = new Budget(0);
  /** An idle gzip decompression positioned after the last member it served. */
  #idle: GzipTarStream | undefined;
  #closing = false;

  constructor(
    path: string,
    admitted?: StableRegularFileDescriptor,
    expandedBytes?: number,
    private readonly limits: TarReaderLimits = DEFAULT_TAR_READER_LIMITS,
  ) {
    this.#source = new ArtifactFileSource(path, "tar archive", admitted);
    this.#expandedBytes = expandedBytes;
  }

  formatMetadata(): TarMetadata | undefined {
    const metadata = this.#prepared?.metadata;
    return metadata === undefined
      ? undefined
      : { ...metadata, dialects: [...metadata.dialects] };
  }

  async prepareContainer(
    expectedSha256: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#scope.run(async () => {
      this.#assertOpen(signal);
      await this.#source.bindSha256(expectedSha256, signal);
    });
  }

  async *entries(
    signal?: AbortSignal,
    options?: ArtifactTraversalOptions,
  ): AsyncIterable<ArtifactEntry> {
    await this.#scope.run(async () => {
      this.#assertOpen(signal);
      if (this.#prepared !== undefined) await this.#source.read(signal);
      await this.#preparation.run(
        signal,
        () => this.#prepare(signal),
        () => this.#assertOpen(signal),
      );
    });
    this.#assertOpen(signal);
    const prepared = this.#prepared!;
    for (const omission of prepared.omissions)
      options?.onOmission?.({ ...omission });
    options?.onCoverage?.({
      ...prepared.coverage,
      limitations: [...prepared.coverage.limitations],
    });
    let index = 0;
    for (const { entry } of prepared.entries.values()) {
      if (index++ % 256 === 0) await setImmediate();
      this.#assertOpen(signal);
      yield copyArtifactEntry(entry);
    }
    this.#assertOpen(signal);
  }

  async open(entry: ArtifactEntry, signal?: AbortSignal): Promise<Readable> {
    return this.#scope.run(async () => {
      this.#assertOpen(signal);
      const state = this.#prepared?.entries.get(entry.adapterKey);
      assertProducedEntry(
        entry,
        state?.entry,
        "tar entry does not match its owning inventory",
      );
      if (state.member.kind !== "file")
        throw new ArtifactReaderFailure(
          "path",
          "tar entry is not a regular file",
        );
      const { handle, initial } = await this.#source.read(signal);
      this.#assertOpen(signal);
      return this.#streams.open(signal, (active) =>
        this.#compression === "gzip"
          ? this.#gzipChunks(handle, initial.size, state.member, active)
          : this.#storedChunks(handle, initial.size, state.member, active),
      );
    });
  }

  async close(): Promise<void> {
    this.#closing = true;
    this.#streams.close();
    this.#idle?.close();
    this.#idle = undefined;
    await this.#scope.close();
    await this.#source.close();
    this.#prepared = undefined;
    this.#preparation.clear();
  }

  provenance(): readonly [] {
    return [];
  }

  #assertOpen(signal?: AbortSignal): void {
    assertArtifactReadActive(signal);
    if (this.#closing)
      throw new ArtifactReaderFailure("unavailable", "tar reader is closed");
  }

  /** Charge plaintext bytes to the archive expansion allowance. */
  #charge = (bytes: number): void => {
    const budget = this.#inflation;
    budget.charge(bytes, () =>
      artifactReaderLimitFailure(
        "artifact_limits.expanded_bytes",
        budget.maximum,
        "bytes",
        undefined,
        "memory",
      ),
    );
  };

  async #prepare(signal?: AbortSignal): Promise<void> {
    const { handle, initial } = await this.#source.read(signal);
    const magic = await readArtifactFileBytes(
      "tar",
      handle,
      0,
      Math.min(3, initial.size),
      initial.size,
      signal,
    );
    const compression = hasGzipMagic(magic) ? "gzip" : "none";
    this.#compression = compression;
    this.#inflation = new Budget(
      this.#expandedBytes ?? artifactExpansionBudgetBytes(initial.size),
    );
    const stream: TarByteStream =
      compression === "gzip"
        ? new GzipTarStream(handle, initial.size, this.#charge)
        : new PlainTarStream(handle, initial.size);
    let walk;
    try {
      walk = await walkTar(stream, signal, this.limits);
    } finally {
      stream.close();
    }
    const entries = new Map<string, TarEntryState>();
    walk.members.forEach((member, index) => {
      const adapterKey = `tar-entry:${String(index)}`;
      entries.set(adapterKey, {
        member,
        entry: {
          path: member.path,
          ...(member.path === member.sourcePath
            ? {}
            : { sourcePath: member.sourcePath }),
          kind: member.kind,
          ...(member.linkTarget === undefined
            ? {}
            : { linkTarget: member.linkTarget }),
          declaredSize: member.kind === "file" ? member.size : null,
          compressedSize: null,
          executable: member.kind === "file" && (member.mode & 0o111) !== 0,
          encrypted: false,
          // Gzip member offsets are decompressed-stream positions, not file bytes.
          byteOffset:
            compression === "none" && member.kind === "file"
              ? member.dataOffset
              : null,
          declaredIntegrity: null,
          unpacked: false,
          limitations: [...member.limitations],
          adapterKey,
          formatMetadata: {
            kind: "tar-entry",
            header_offset: member.headerOffset,
            data_offset: member.dataOffset,
            typeflag: member.typeflag,
            mode: member.mode,
            uid: member.uid,
            gid: member.gid,
            mtime: member.mtime,
            uname: member.uname,
            gname: member.gname,
            link_name: member.linkName,
          },
        },
      });
    });
    await this.#source.read(signal);
    this.#assertOpen(signal);
    const complete =
      walk.endState === "end-marker" && walk.trailingNonZeroBytes === 0;
    this.#prepared = {
      entries,
      omissions: walk.omissions,
      coverage: {
        status: complete ? "complete" : "unknown",
        limitations: [...walk.limitations],
      },
      metadata: {
        kind: "tar",
        compression,
        dialects: [...walk.dialects],
        pax_headers: walk.paxHeaders,
        member_count: walk.members.length,
        tar_stream_bytes: walk.streamBytes,
        end_state: walk.endState,
        end_offset: walk.endOffset,
        trailing_nonzero_bytes: walk.trailingNonZeroBytes,
      },
    };
  }

  async *#storedChunks(
    handle: FileHandle,
    size: number,
    member: TarMember,
    signal: AbortSignal,
  ): AsyncGenerator<Buffer> {
    const end = member.dataOffset + member.size;
    let chunks = 0;
    for (let position = member.dataOffset; position < end;) {
      if (chunks++ % 64 === 63) await setImmediate();
      this.#assertOpen(signal);
      const toRead = Math.min(CHUNK_BYTES, end - position);
      this.#charge(toRead);
      const chunk = await readArtifactFileBytes(
        "tar",
        handle,
        position,
        toRead,
        size,
        signal,
      );
      position += chunk.length;
      yield chunk;
    }
    await this.#source.read(signal);
  }

  async *#gzipChunks(
    handle: FileHandle,
    size: number,
    member: TarMember,
    signal: AbortSignal,
  ): AsyncGenerator<Buffer> {
    const idle = this.#idle;
    let stream: GzipTarStream;
    if (idle !== undefined && idle.position <= member.dataOffset) {
      this.#idle = undefined;
      stream = idle;
    } else stream = new GzipTarStream(handle, size, this.#charge);
    let finished = false;
    try {
      try {
        const skipped = await stream.skip(
          member.dataOffset - stream.position,
          signal,
        );
        if (stream.position !== member.dataOffset || skipped < 0)
          throw endedEarly(member);
        let remaining = member.size;
        for (let chunks = 0; remaining > 0; chunks++) {
          if (chunks % 64 === 63) await setImmediate();
          this.#assertOpen(signal);
          const chunk = await stream.read(
            Math.min(CHUNK_BYTES, remaining),
            signal,
          );
          if (chunk.length === 0) throw endedEarly(member);
          remaining -= chunk.length;
          yield chunk;
        }
      } catch (cause: unknown) {
        if (cause instanceof TarStreamEnded)
          throw new ArtifactReaderFailure("integrity", cause.message, {
            integrityCheck: "declared-size",
            cause,
          });
        throw cause;
      }
      await this.#source.read(signal);
      finished = true;
    } finally {
      if (finished && !this.#closing) {
        this.#idle?.close();
        this.#idle = stream;
      } else stream.close();
    }
  }
}

const endedEarly = (member: TarMember): ArtifactReaderFailure =>
  new ArtifactReaderFailure(
    "integrity",
    `tar entry ended early: ${member.path}`,
    { integrityCheck: "declared-size" },
  );
