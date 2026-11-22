import type { Readable } from "node:stream";

import {
  auditdLogMetadataSchema,
  type ArtifactFormatMetadata,
} from "../domain/artifactFormatMetadata.js";
import type { RegionDecodeFailure } from "../domain/firmware/regionDecoder.js";
import {
  createAuditdLogDecoder,
  type AuditdLogInventory,
} from "../domain/linux/auditdLog.js";
import {
  ArtifactReaderFailure,
  type ArtifactEntry,
  type ArtifactReader,
  type ArtifactReaderTraversal,
  type ArtifactTraversalOptions,
  ArtifactResourceScope,
  assertArtifactReadActive,
  ArtifactFileSource,
  yieldArtifactRead,
} from "../resources/index.js";
import { ArtifactPreparation } from "./ArtifactPreparation.js";
import { readFileHandleChunks } from "../filesystem/readFileHandleChunks.js";
import type { StableRegularFileDescriptor } from "../filesystem/RegularFile.js";

/**
 * An auditd log is its own content: records describe events on the source
 * host, not members inside the file, so the inventory is attached to the root
 * occurrence and there is nothing to open.
 */
export class AuditdLogArtifactReader implements ArtifactReader {
  readonly format = "auditd-log" as const;
  readonly #scope = new ArtifactResourceScope();
  readonly #source: ArtifactFileSource;
  readonly #preparation = new ArtifactPreparation();
  #metadata: ArtifactFormatMetadata | undefined;
  #limitations: readonly string[] = [];
  #closing = false;

  constructor(path: string, admitted?: StableRegularFileDescriptor) {
    this.#source = new ArtifactFileSource(path, "auditd log", admitted);
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
    // The log declares no members, so the root occurrence is the whole
    // inventory; the coverage callback reports what the parse did not establish.
    const coverage =
      this.#limitations.length === 0
        ? { status: "complete" as const, limitations: [] }
        : { status: "unknown" as const, limitations: [...this.#limitations] };
    options?.onCoverage?.(coverage);
    // onCoverage may abort the supplied signal; cancellation queued during the
    // await must resolve as cancelled rather than as a completed traversal.
    await yieldArtifactRead(signal);
  }

  async open(entry: ArtifactEntry, _signal?: AbortSignal): Promise<Readable> {
    return this.#scope.run(async () => {
      throw new ArtifactReaderFailure(
        "unavailable",
        `auditd log declares no member to open for ${entry.path}`,
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
        "auditd log reader is closed",
      );
  }

  async #prepare(signal?: AbortSignal): Promise<void> {
    const image = await this.#decode(signal);
    this.#metadata = auditdLogMetadataSchema.parse(image.metadata);
    this.#limitations = image.limitations;
    await this.#source.read(signal);
  }

  async #decode(signal?: AbortSignal): Promise<AuditdLogInventory> {
    const { handle, initial } = await this.#source.read(signal);
    const decoder = createAuditdLogDecoder(initial.size);
    if (!decoder.ok) throw this.#failure(decoder.error);
    if (initial.size > 0)
      for await (const chunk of readFileHandleChunks(handle, {
        end: initial.size - 1,
        signal,
        cancellationFailure: (reason) =>
          new ArtifactReaderFailure("cancelled", "auditd log read cancelled", {
            cause: reason,
          }),
      }) as AsyncIterable<Buffer>) {
        this.#assertOpen(signal);
        // The scanner joins records line by line and keeps only aggregate
        // facts, so each chunk's work is bounded and cancellation is never
        // blocked on a whole-file buffer.
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
          `auditd log is malformed: ${failure.message}`,
        )
      : new ArtifactReaderFailure(
          "limit",
          `auditd log exceeds a fixed limit: ${failure.message}`,
          failure.boundary === undefined ? {} : { boundary: failure.boundary },
        );
  }
}
