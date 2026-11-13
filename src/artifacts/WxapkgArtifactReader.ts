import { ArtifactPreparation } from "./ArtifactPreparation.js";
import { artifactExpansionBudgetBytes } from "../domain/artifactExpansionBudget.js";
import type { FileHandle } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import { Readable } from "node:stream";
import {
  ArtifactReaderFailure,
  artifactFixedLimitFailure,
  copyArtifactEntry,
  sameArtifactEntry,
  type ArtifactEntry,
  type ArtifactReader,
  type ArtifactTraversalOptions,
} from "./ArtifactReader.js";
import { ArtifactResourceScope } from "./ArtifactResourceScope.js";
import { ownAsyncArtifactStream } from "./OwnedAsyncArtifactStream.js";
import { assertArtifactReadActive } from "./ArtifactFileOperation.js";
import { readArtifactFileBytes } from "./ArtifactFileRange.js";
import type {
  ArtifactFormatMetadata,
  WxapkgMetadata,
} from "../domain/artifactFormatMetadata.js";
import type { StableRegularFileDescriptor } from "../filesystem/RegularFile.js";
import { ArtifactFileSource } from "./ArtifactFileSource.js";
import {
  readWxapkgFileTable,
  readWxapkgHeader,
  wxapkgFormatFailure,
  type WxapkgMember,
} from "./WxapkgStructures.js";

const CHUNK_BYTES = 64 * 1024;
/** Bound active member streams; each owns a file-range generator. */
const MAX_MEMBER_STREAMS = 4;

type WxapkgEntry = ArtifactEntry & {
  readonly declaredSize: number;
  readonly formatMetadata: Extract<
    ArtifactFormatMetadata,
    { kind: "wxapkg-entry" }
  >;
};

interface WxapkgEntryState {
  readonly entry: WxapkgEntry;
  readonly member: WxapkgMember;
}

/** One descriptor, one admitted member table and bounded raw-range member reads. */
export class WxapkgArtifactReader implements ArtifactReader {
  readonly format = "wxapkg" as const;
  readonly #scope = new ArtifactResourceScope();
  #entries = new Map<string, WxapkgEntryState>();
  readonly #streams = new Map<Readable, AbortController>();
  readonly #source: ArtifactFileSource;
  readonly #preparation = new ArtifactPreparation();
  #header: WxapkgMetadata | undefined;
  #remainingReadOperations = 0;
  #admittedReadOperations = 0;
  #closing = false;

  constructor(path: string, admitted?: StableRegularFileDescriptor) {
    this.#source = new ArtifactFileSource(path, "wxapkg package", admitted);
  }

  formatMetadata(): WxapkgMetadata | undefined {
    return this.#header === undefined ? undefined : { ...this.#header };
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
      await this.#preparation.run(
        signal,
        () => this.#prepare(signal),
        () => this.#assertOpen(signal),
      );
      await this.#source.read(signal);
    });
    this.#assertOpen(signal);
    if (this.#header?.directory_status === "encrypted") {
      options?.onCoverage?.({
        status: "unknown",
        limitations: [
          "wxapkg package is V1MMWX-encrypted; member identities and contents remain unknown.",
        ],
      });
      this.#assertOpen(signal);
      return;
    }
    let index = 0;
    for (const { entry } of this.#entries.values()) {
      if (index++ % 256 === 0) await setImmediate();
      this.#assertOpen(signal);
      yield copyArtifactEntry(entry);
    }
    // A close while paused at yield must not turn a cleared map into completion.
    this.#assertOpen(signal);
  }

  async open(entry: ArtifactEntry, signal?: AbortSignal): Promise<Readable> {
    return this.#scope.run(async () => {
      this.#assertOpen(signal);
      const state = this.#entries.get(entry.adapterKey);
      if (state === undefined || !sameArtifactEntry(entry, state.entry))
        throw new ArtifactReaderFailure(
          "integrity",
          "wxapkg entry does not match its owning inventory",
        );
      // Every logical open spends the work budget, including empty members
      // whose streams perform only the carrier checks below.
      this.#reserveMemberRead();
      // Validate carrier freshness before handing out member bytes.
      const { handle } = await this.#source.read(signal);
      this.#assertOpen(signal);
      if (this.#streams.size >= MAX_MEMBER_STREAMS)
        throw new ArtifactReaderFailure(
          "limit",
          "wxapkg reader already owns four active member streams",
          { boundary: "capacity" },
        );
      const controller = new AbortController();
      const output = ownAsyncArtifactStream(
        this.#memberChunks(handle, state, controller.signal),
        controller,
        {
          scope: this.#scope,
          streams: this.#streams,
          signal,
          label: "wxapkg",
          highWaterMark: CHUNK_BYTES,
        },
      );
      return output;
    });
  }

  async close(): Promise<void> {
    this.#closing = true;
    for (const [stream, controller] of this.#streams) {
      const cause = new ArtifactReaderFailure(
        "unavailable",
        "wxapkg reader closed",
      );
      controller.abort(cause);
      stream.destroy(cause);
    }
    await this.#scope.close();
    await this.#source.close();
    this.#entries.clear();
  }

  provenance(): readonly [] {
    return [];
  }

  #assertOpen(signal?: AbortSignal): void {
    assertArtifactReadActive(signal);
    if (this.#closing)
      throw new ArtifactReaderFailure("unavailable", "wxapkg reader is closed");
  }

  async #prepare(signal?: AbortSignal): Promise<void> {
    const { handle, initial } = await this.#source.read(signal);
    const header = await readWxapkgHeader(handle, initial.size, signal);
    if (header === undefined)
      throw wxapkgFormatFailure("no complete wxapkg header");
    const metadata: WxapkgMetadata = {
      kind: "wxapkg",
      info: header.layout.status === "available" ? header.info : null,
      index_length:
        header.layout.status === "available" ? header.indexLength : null,
      data_length:
        header.layout.status === "available" ? header.dataLength : null,
      file_count:
        header.layout.status === "available" ? header.fileCount : null,
      directory_status: header.layout.status,
    };
    if (header.layout.status !== "available") {
      await this.#source.read(signal);
      this.#assertOpen(signal);
      this.#header = metadata;
      return;
    }
    const { members } = await readWxapkgFileTable(
      handle,
      header,
      initial.size,
      signal,
    );
    const budget = artifactExpansionBudgetBytes(initial.size);
    const entries = new Map<string, WxapkgEntryState>();
    let declaredBytes = 0n;
    for (let index = 0; index < members.length; index++) {
      if (index % 256 === 0) await setImmediate();
      this.#assertOpen(signal);
      const member = members[index]!;
      // Overlapping member ranges are valid; each declared path causes a read.
      declaredBytes += BigInt(member.size);
      if (declaredBytes > BigInt(budget))
        throw new ArtifactReaderFailure(
          "limit",
          `wxapkg members declare ${String(declaredBytes)} bytes, exceeding the ${String(budget)}-byte plaintext-work budget`,
          { boundary: "memory" },
        );
      const adapterKey = `wxapkg-entry:${String(index)}`;
      entries.set(adapterKey, {
        entry: {
          path: member.path,
          sourcePath: member.declaredPath,
          kind: "file",
          declaredSize: member.size,
          compressedSize: null,
          executable: false,
          encrypted: false,
          // Member offsets are absolute carrier positions.
          byteOffset: member.offset,
          declaredIntegrity: null,
          unpacked: false,
          limitations: [],
          adapterKey,
          formatMetadata: {
            kind: "wxapkg-entry",
            index,
            source_path: member.declaredPath,
            declared_offset: member.offset,
          },
        },
        member,
      });
    }
    // Header, table and per-chunk member reads; a small-reader floor applies.
    const admittedReadOperations =
      4 *
      Math.max(
        1024,
        members.length + Math.ceil(Number(declaredBytes) / CHUNK_BYTES),
      );
    await this.#source.read(signal);
    this.#assertOpen(signal);
    this.#header = metadata;
    this.#entries = entries;
    this.#admittedReadOperations = admittedReadOperations;
    this.#remainingReadOperations = admittedReadOperations;
  }

  async *#memberChunks(
    handle: FileHandle,
    state: WxapkgEntryState,
    signal: AbortSignal,
  ): AsyncGenerator<Buffer> {
    const { offset, size } = state.member;
    let delivered = 0,
      chunks = 0;
    for (let position = offset; position < offset + size;) {
      if (chunks++ % 64 === 0) await setImmediate();
      this.#assertOpen(signal);
      this.#reserveMemberRead();
      const length = Math.min(CHUNK_BYTES, offset + size - position);
      const chunk = await readArtifactFileBytes(
        handle,
        position,
        length,
        offset + size,
        signal,
      );
      position += chunk.length;
      delivered += chunk.length;
      yield chunk;
    }
    if (delivered !== size)
      throw wxapkgFormatFailure("member ended before its declared size");
    await this.#source.read(signal);
  }

  #reserveMemberRead(): void {
    if (this.#remainingReadOperations <= 0)
      throw artifactFixedLimitFailure(
        "wxapkg directory-and-chunk I/O work",
        this.#admittedReadOperations,
        "operations",
      );
    this.#remainingReadOperations--;
  }
}
