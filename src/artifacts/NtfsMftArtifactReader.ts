import type { Readable } from "node:stream";

import {
  ntfsMftMetadataSchema,
  type ArtifactFormatMetadata,
} from "../domain/artifactFormatMetadata.js";
import type { RegionDecodeFailure } from "../domain/firmware/regionDecoder.js";
import {
  createMftDecoder,
  type MftInventory,
} from "../domain/windows/ntfsMft.js";
import {
  ArtifactReaderFailure,
  type ArtifactEntry,
  type ArtifactReaderTraversal,
} from "../resources/index.js";
import {
  PositionalArtifactReader,
  type PositionalArtifactEntries,
} from "./PositionalArtifactReader.js";
import { readFileHandleChunks } from "../filesystem/readFileHandleChunks.js";
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
        if (!written.ok) throw this.#failure(written.error);
      }
    const image = decoder.value.finish();
    if (!image.ok) throw this.#failure(image.error);
    return image.value;
  }

  #failure(failure: RegionDecodeFailure): ArtifactReaderFailure {
    return failure.kind === "format"
      ? new ArtifactReaderFailure(
          "format",
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
