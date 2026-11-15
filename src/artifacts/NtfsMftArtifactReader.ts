import { ArtifactPreparation } from "./ArtifactPreparation.js";
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
  type ArtifactReader,
  type ArtifactReaderTraversal,
  type ArtifactTraversalOptions,
} from "./ArtifactReader.js";
import { ArtifactResourceScope } from "./ArtifactResourceScope.js";
import { assertArtifactReadActive } from "./ArtifactFileOperation.js";
import { ArtifactFileSource } from "./ArtifactFileSource.js";
import { readFileHandleChunks } from "../filesystem/readFileHandleChunks.js";
import type { StableRegularFileDescriptor } from "../filesystem/RegularFile.js";

/**
 * An MFT stream is its own content: the FILE records describe the source
 * volume, not members inside the stream, so header facts are attached to
 * the root occurrence.
 */
export class NtfsMftArtifactReader implements ArtifactReader {
  readonly format = "ntfs-mft" as const;
  readonly #scope = new ArtifactResourceScope();
  readonly #source: ArtifactFileSource;
  readonly #preparation = new ArtifactPreparation();
  #metadata: ArtifactFormatMetadata | undefined;
  #limitations: readonly string[] = [];
  #closing = false;

  constructor(path: string, admitted?: StableRegularFileDescriptor) {
    this.#source = new ArtifactFileSource(path, "$MFT stream", admitted);
  }

  formatMetadata(): ArtifactFormatMetadata | undefined {
    return this.#metadata === undefined
      ? undefined
      : structuredClone(this.#metadata);
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
      this.#assertOpen(signal);
      await this.#source.read(signal);
    });
    // An MFT declares no members, so the root occurrence is the whole
    // inventory; the coverage callback reports what its parse did not establish.
    options?.onCoverage?.(coverageOf(this.#limitations));
    this.#assertOpen(signal);
  }

  async open(entry: ArtifactEntry, _signal?: AbortSignal): Promise<Readable> {
    return this.#scope.run(async () => {
      throw new ArtifactReaderFailure(
        "unavailable",
        `$MFT stream declares no member to open for ${entry.path}`,
      );
    });
  }

  async close(): Promise<void> {
    this.#closing = true;
    await this.#scope.close();
    await this.#source.close();
    this.#metadata = undefined;
  }

  provenance(): readonly [] {
    return [];
  }

  #assertOpen(signal?: AbortSignal): void {
    assertArtifactReadActive(signal);
    if (this.#closing)
      throw new ArtifactReaderFailure(
        "unavailable",
        "$MFT stream reader is closed",
      );
  }

  async #prepare(signal?: AbortSignal): Promise<void> {
    const image = await this.#decode(signal);
    await this.#source.read(signal);
    this.#metadata = ntfsMftMetadataSchema.parse(image.metadata);
    this.#limitations = image.limitations;
  }

  async #decode(signal?: AbortSignal): Promise<MftInventory> {
    const { handle, initial } = await this.#source.read(signal);
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
        this.#assertOpen(signal);
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
