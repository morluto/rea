import type { Readable } from "node:stream";

import { artifactExpansionBudgetBytes } from "../domain/artifactExpansionBudget.js";
import {
  N64_CHECKSUM_END,
  N64_FORMAT,
  N64_MAX_ROM_BYTES,
  N64_ROM_BYTES_LIMIT,
  n64ByteOrder,
  n64RomMemberBytes,
  n64RomSizeFailure,
  parseN64Rom,
  swapN64Bytes,
  type N64ByteOrder,
  type N64RomMetadata,
} from "../domain/n64Rom.js";
import { ParseFailureError } from "../domain/parseFailure.js";
import type { StableRegularFileDescriptor } from "../filesystem/RegularFile.js";
import {
  artifactFixedLimitFailure,
  artifactParseFailure,
  artifactReadCancelledBy,
  artifactReaderLimitFailure,
} from "../resources/index.js";
import { readArtifactFileBytes } from "./ArtifactFileRange.js";
import {
  decodedArtifactMemberSource,
  type ArtifactMemberLifecycle,
  type DecodedMemberReadState,
} from "./OwnedArtifactStream.js";
import {
  PositionalArtifactReader,
  type PositionalArtifactEntries,
  type PositionalArtifactEntry,
} from "./PositionalArtifactReader.js";

/**
 * Nintendo 64 cartridge ROM. Header facts come from the domain parser.
 * `header.bin`, `ipl3.bin` and `program.z64` are stored ranges when the dump
 * is already big-endian. v64 and n64 dumps serve those same ranges after one
 * byte-order swap so every entry is big-endian. Nothing is executed or
 * patched. A CRC mismatch stays a limitation.
 */
export class N64RomArtifactReader extends PositionalArtifactReader<N64RomMetadata> {
  override readonly format = N64_FORMAT;

  #order: N64ByteOrder = "z64";

  constructor(
    path: string,
    admitted?: StableRegularFileDescriptor,
    private readonly expandedBytes?: number,
  ) {
    super(path, "Nintendo 64 ROM", admitted);
  }

  formatMetadata(): N64RomMetadata | undefined {
    const metadata = this.preparedFormatMetadata;
    return metadata === undefined ? undefined : structuredClone(metadata);
  }

  protected override async prepareEntries(
    signal?: AbortSignal,
  ): Promise<PositionalArtifactEntries<N64RomMetadata>> {
    const { handle, initial } = await this.verifyCarrier(signal);
    let image: ReturnType<typeof parseN64Rom>;
    try {
      const sizeFailure = n64RomSizeFailure(initial.size);
      if (sizeFailure !== undefined) throw sizeFailure;
      // The member layout depends only on the size and byte order, so the
      // allowance is charged from the first word before the checksum window
      // is read and normalized.
      const magic = await readArtifactFileBytes(
        this.format,
        handle,
        0,
        4,
        initial.size,
        signal,
      );
      this.assertOpen(signal);
      const order = n64ByteOrder(magic);
      if (order !== undefined) {
        const alignment = n64RomSizeFailure(initial.size, order);
        if (alignment !== undefined) throw alignment;
        this.#admitMembers(initial.size, order);
      }
      const covered = Math.min(initial.size, N64_CHECKSUM_END);
      const bytes = await readArtifactFileBytes(
        this.format,
        handle,
        0,
        covered,
        initial.size,
        signal,
      );
      this.assertOpen(signal);
      image = parseN64Rom(bytes, initial.size);
    } catch (cause: unknown) {
      if (
        cause instanceof ParseFailureError &&
        cause.failure.kind === "limit" &&
        cause.failure.limit.name === N64_ROM_BYTES_LIMIT
      )
        throw artifactFixedLimitFailure(
          {
            name: "The Nintendo 64 ROM size allowance",
            kind: "bytes",
            limit: N64_MAX_ROM_BYTES,
            unit: "bytes",
          },
          cause.message,
          "file-size",
          { cause },
        );
      if (cause instanceof ParseFailureError)
        throw artifactParseFailure(cause, signal);
      throw cause;
    }
    this.#order = image.metadata.source_order;
    const entries = image.entries.map((region): PositionalArtifactEntry => ({
      path: region.path,
      kind: "file",
      declaredSize: region.length,
      compressedSize: null,
      executable: false,
      encrypted: false,
      byteOffset: region.offset,
      declaredIntegrity: null,
      unpacked: false,
      limitations: [],
      adapterKey: `n64-rom:${region.path}`,
      formatMetadata: region.metadata,
    }));
    return {
      entries,
      coverage: {
        status: image.limitations.length === 0 ? "complete" : "unknown",
        limitations: [...image.limitations],
      },
      formatMetadata: image.metadata,
    };
  }

  /** Refuse before allocation when the served members exceed the allowance. */
  #admitMembers(fileSize: number, order: N64ByteOrder): void {
    const expansionBudget =
      this.expandedBytes ?? artifactExpansionBudgetBytes(fileSize);
    const required = n64RomMemberBytes(fileSize, order);
    if (required > BigInt(expansionBudget))
      throw artifactReaderLimitFailure(
        "artifact_limits.expanded_bytes",
        expansionBudget,
        "bytes",
        required,
        "memory",
      );
  }

  /**
   * Big-endian bytes for a v64 or n64 member. z64 members stay on the stored
   * range. Header, IPL3 and `program.z64` each use one {@link swapN64Bytes}
   * of the stored slice.
   */
  protected override entrySource(
    entry: PositionalArtifactEntry,
    carrier: StableRegularFileDescriptor,
    member: ArtifactMemberLifecycle,
  ): Readable | undefined {
    if (this.#order === "z64") return undefined;
    return decodedArtifactMemberSource(member, (onStateChange) =>
      this.#decoded(entry, carrier, member, onStateChange),
    );
  }

  async *#decoded(
    entry: PositionalArtifactEntry,
    { handle, initial }: StableRegularFileDescriptor,
    member: ArtifactMemberLifecycle,
    onStateChange: (state: DecodedMemberReadState) => void,
  ): AsyncIterable<Buffer> {
    const { signal, cancellationFailure } = member;
    onStateChange("pending");
    let normalized: Uint8Array;
    try {
      if (signal.aborted) throw cancellationFailure(signal.reason);
      const stored = await readArtifactFileBytes(
        N64_FORMAT,
        handle,
        entry.byteOffset,
        entry.declaredSize,
        initial.size,
        signal,
      );
      normalized = swapN64Bytes(stored, this.#order);
      onStateChange("idle");
    } catch (cause) {
      onStateChange("failed");
      if (artifactReadCancelledBy(cause, signal))
        throw cancellationFailure(signal.reason);
      if (cause instanceof ParseFailureError)
        throw artifactParseFailure(cause, signal);
      throw cause;
    }
    if (signal.aborted) throw cancellationFailure(signal.reason);
    yield Buffer.from(
      normalized.buffer,
      normalized.byteOffset,
      normalized.length,
    );
  }
}
