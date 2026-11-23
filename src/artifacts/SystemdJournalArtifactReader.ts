import type { Readable } from "node:stream";

import type { ArtifactFormatMetadata } from "../domain/artifactFormatMetadata.js";
import { systemdJournalMetadataSchema } from "../domain/formatMetadata/androidAndSystemMetadata.js";
import type { RegionDecodeFailure } from "../domain/firmware/regionDecoder.js";
import {
  createJournalDecoder,
  hasSystemdJournalHeader,
  type JournalInventory,
} from "../domain/linux/systemdJournal.js";
import {
  ArtifactReaderFailure,
  type ArtifactEntry,
  type ArtifactReader,
  type ArtifactReaderTraversal,
  type ArtifactTraversalOptions,
  ArtifactResourceScope,
  assertArtifactReadActive,
  ArtifactFileSource,
} from "../resources/index.js";
import { malformedInput, truncatedInput } from "../domain/parseFailure.js";
import { ArtifactPreparation } from "./ArtifactPreparation.js";
import { readFileHandleChunks } from "../filesystem/readFileHandleChunks.js";
import { readFileHandleRange } from "../filesystem/readFileHandleRange.js";
import type { StableRegularFileDescriptor } from "../filesystem/RegularFile.js";

/**
 * A journal file is its own content: entries and fields describe the source
 * system, not members inside the file, so header facts are attached to the
 * root occurrence.
 */
export class SystemdJournalArtifactReader implements ArtifactReader {
  readonly format = "systemd-journal" as const;
  readonly #scope = new ArtifactResourceScope();
  readonly #source: ArtifactFileSource;
  readonly #preparation = new ArtifactPreparation();
  /** True when the file starts with the journal signature, even if it is short. */
  #signatureSeen = false;
  #metadata: ArtifactFormatMetadata | undefined;
  #limitations: readonly string[] = [];
  #closing = false;

  constructor(path: string, admitted?: StableRegularFileDescriptor) {
    this.#source = new ArtifactFileSource(
      path,
      "systemd journal file",
      admitted,
    );
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
    // A journal declares no members, so the root occurrence is the whole
    // inventory; the coverage callback reports what its parse did not establish.
    options?.onCoverage?.(coverageOf(this.#limitations));
  }

  async open(entry: ArtifactEntry, _signal?: AbortSignal): Promise<Readable> {
    return this.#scope.run(async () => {
      throw new ArtifactReaderFailure(
        "unavailable",
        `systemd journal file declares no member to open for ${entry.path}`,
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
        "systemd journal reader is closed",
      );
  }

  async #prepare(signal?: AbortSignal): Promise<void> {
    const image = await this.#decode(signal);
    await this.#source.read(signal);
    this.#metadata = systemdJournalMetadataSchema.parse(image.metadata);
    this.#limitations = image.limitations;
  }

  async #decode(signal?: AbortSignal): Promise<JournalInventory> {
    const { handle, initial } = await this.#source.read(signal);
    // The signature is all a truncated file needs to be recognized as a
    // journal, so it is read before the decoder's header requirement applies.
    this.#signatureSeen = hasSystemdJournalHeader(
      initial.size === 0
        ? new Uint8Array()
        : await readFileHandleRange(handle, 0, 8, () =>
            assertArtifactReadActive(signal),
          ),
    );
    const decoder = createJournalDecoder(initial.size);
    if (!decoder.ok) throw this.#failure(decoder.error);
    if (initial.size > 0)
      for await (const chunk of readFileHandleChunks(handle, {
        end: initial.size - 1,
        signal,
        cancellationFailure: (reason) =>
          new ArtifactReaderFailure(
            "cancelled",
            "systemd journal read cancelled",
            { cause: reason },
          ),
      }) as AsyncIterable<Buffer>) {
        this.#assertOpen(signal);
        // The decoder discards payload bytes as they stream past, so each
        // chunk's work is bounded and cancellation is never blocked on a
        // whole-file buffer.
        const written = decoder.value.write(chunk);
        if (!written.ok) throw this.#failure(written.error);
      }
    const image = decoder.value.finish();
    if (!image.ok) throw this.#failure(image.error);
    return image.value;
  }

  #failure(failure: RegionDecodeFailure): ArtifactReaderFailure {
    if (failure.kind === "limit")
      return new ArtifactReaderFailure(
        "limit",
        `systemd journal file exceeds a fixed limit: ${failure.message}`,
        failure.boundary === undefined ? {} : { boundary: failure.boundary },
      );
    // The signature establishes the format before any structure does, so a
    // file that carries it and stops short is truncated input, not bytes of
    // an unknown shape. The parse failure keeps that distinction for callers
    // that report a reason.
    const signed = this.#signatureSeen;
    return new ArtifactReaderFailure(
      "format",
      `systemd journal file is malformed: ${failure.message}`,
      {
        cause: signed
          ? truncatedInput("systemd-journal", failure.message)
          : malformedInput("systemd-journal", failure.message),
      },
    );
  }
}

const coverageOf = (limitations: readonly string[]): ArtifactReaderTraversal =>
  limitations.length === 0
    ? { status: "complete", limitations: [] }
    : { status: "unknown", limitations };
