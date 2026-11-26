import type { Readable } from "node:stream";

import type { ArtifactFormatMetadata } from "../domain/artifactFormatMetadata.js";
import { ntfsMftMetadataSchema } from "../domain/formatMetadata/androidAndSystemMetadata.js";
import type { RegionDecodeFailure } from "../domain/firmware/regionDecoder.js";
import {
  createMftDecoder,
  type MftInventory,
} from "../domain/windows/ntfsMft.js";
import {
  ArtifactReaderFailure,
  malformedArtifact,
  type ArtifactEntry,
  type ArtifactReaderTraversal,
} from "../resources/index.js";
import {
  PositionalArtifactReader,
  type PositionalArtifactEntries,
} from "./PositionalArtifactReader.js";
import { readFileHandleChunks } from "../filesystem/readFileHandleChunks.js";
import { readFileHandleRange } from "../filesystem/readFileHandleRange.js";
import type { StableRegularFileDescriptor } from "../filesystem/RegularFile.js";

/**
 * An MFT stream is its own content: the FILE records describe the source
 * volume, not members inside the stream, so header facts are attached to
 * the root occurrence.
 */
export class NtfsMftArtifactReader extends PositionalArtifactReader<ArtifactFormatMetadata> {
  override readonly format = "ntfs-mft" as const;

  constructor(path: string, admitted?: StableRegularFileDescriptor) {
    super(path, "$MFT stream", admitted);
  }

  formatMetadata(): ArtifactFormatMetadata | undefined {
    const metadata = this.preparedFormatMetadata;
    return metadata === undefined ? undefined : structuredClone(metadata);
  }

  override async open(
    entry: ArtifactEntry,
    _signal?: AbortSignal,
  ): Promise<Readable> {
    throw new ArtifactReaderFailure(
      "unavailable",
      `$MFT stream declares no member to open for ${entry.path}`,
    );
  }

  protected override async prepareEntries(
    signal?: AbortSignal,
  ): Promise<PositionalArtifactEntries<ArtifactFormatMetadata>> {
    const image = await this.#decode(signal);
    return {
      entries: [],
      coverage: coverageOf(image.limitations),
      formatMetadata: ntfsMftMetadataSchema.parse(image.metadata),
    };
  }

  async #decode(signal?: AbortSignal): Promise<MftInventory> {
    const { handle, initial } = await this.verifyCarrier(signal);
    const decoder = createMftDecoder(initial.size);
    if (!decoder.ok) throw this.#failure(decoder.error);
    if (initial.size > 0)
      for await (const chunk of readFileHandleChunks(handle, {
        end: initial.size - 1,
        signal,
        cancellationFailure: (reason) =>
          new ArtifactReaderFailure("cancelled", "$MFT stream read cancelled", {
            cause: reason,
          }),
      }) as AsyncIterable<Buffer>) {
        this.assertOpen(signal);
        const written = decoder.value.write(chunk);
        if (!written.ok) throw await this.#stableFailure(written.error, signal);
      }
    const image = await decoder.value.finish((offset, length) =>
      readFileHandleRange(handle, offset, length, () =>
        this.assertOpen(signal),
      ),
    );
    if (!image.ok) throw await this.#stableFailure(image.error, signal);
    return image.value;
  }

  /**
   * A decoder failure blames the bytes only once the carrier is shown to be
   * unchanged; a carrier that shrank or changed reports that instead.
   */
  async #stableFailure(
    failure: RegionDecodeFailure,
    signal: AbortSignal | undefined,
  ): Promise<ArtifactReaderFailure> {
    await this.verifyCarrier(signal);
    return this.#failure(failure);
  }

  #failure(failure: RegionDecodeFailure): ArtifactReaderFailure {
    return failure.kind === "malformed"
      ? malformedArtifact(
          "ntfs-mft",
          `$MFT stream is malformed: ${failure.message}`,
        )
      : new ArtifactReaderFailure(
          "limit",
          `$MFT stream exceeds a fixed limit: ${failure.message}`,
          failure.boundary === undefined ? {} : { boundary: failure.boundary },
        );
  }
}

const coverageOf = (limitations: readonly string[]): ArtifactReaderTraversal =>
  limitations.length === 0
    ? { status: "complete", limitations: [] }
    : { status: "unknown", limitations };
