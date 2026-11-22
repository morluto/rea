import { ArtifactPreparation } from "./ArtifactPreparation.js";
import { Readable, Transform } from "node:stream";
import { setImmediate } from "node:timers/promises";

import {
  ArtifactReaderFailure,
  copyArtifactEntry,
  assertProducedEntry,
  type ArtifactEntry,
  type ArtifactReader,
  type ArtifactReaderTraversal,
  type ArtifactTraversalOptions,
  ArtifactResourceScope,
  assertArtifactReadActive,
  ArtifactFileSource,
} from "../resources/index.js";
import {
  ArtifactStreamLifecycle,
  ownArtifactStream,
  type ArtifactMemberLifecycle,
} from "./OwnedArtifactStream.js";
import { readFileHandleChunks } from "../filesystem/readFileHandleChunks.js";
import type { StableRegularFileDescriptor } from "../filesystem/RegularFile.js";
import type { ArtifactFormatMetadata } from "../domain/artifactFormatMetadata.js";
import { invariantViolation } from "../domain/internalInvariant.js";

/** An entry whose bytes are one range of the carrier. */
export type PositionalArtifactEntry = ArtifactEntry & {
  readonly byteOffset: number;
  readonly declaredSize: number;
};

/** The entries one preparation established and the coverage to report. */
export interface PositionalArtifactEntries<
  Metadata = never,
  Entry extends ArtifactEntry = PositionalArtifactEntry,
> {
  readonly entries: readonly Entry[];
  /** The coverage the preparation established, including complete coverage. */
  readonly coverage: ArtifactReaderTraversal;
  readonly formatMetadata?: Metadata;
}

/**
 * Serve entries that are byte ranges of one carrier file. Preparation runs
 * once; every traversal, open and completed entry stream rechecks the
 * carrier's identity, and close retires open streams before the carrier.
 * Encrypted entries are listed but never opened.
 */
export abstract class PositionalArtifactReader<
  Metadata extends ArtifactFormatMetadata = never,
  Entry extends ArtifactEntry = PositionalArtifactEntry,
> implements ArtifactReader {
  abstract readonly format: ArtifactReader["format"];
  readonly #scope = new ArtifactResourceScope();
  readonly #lifecycle: ArtifactStreamLifecycle;
  readonly #label: string;
  readonly #source: ArtifactFileSource;
  readonly #verifySelectedPath: boolean;
  readonly #preparation = new ArtifactPreparation();
  #prepared:
    | {
        readonly entries: ReadonlyMap<string, Entry>;
        readonly coverage: ArtifactReaderTraversal;
        readonly formatMetadata: Metadata | undefined;
      }
    | undefined;

  constructor(
    path: string,
    label: string,
    admitted?: StableRegularFileDescriptor,
    sourceOptions:
      | string
      | {
          readonly sourceLabel?: string;
          readonly verifySelectedPath?: boolean;
        } = label,
  ) {
    this.#label = label;
    this.#lifecycle = new ArtifactStreamLifecycle(label);
    const sourceLabel =
      typeof sourceOptions === "string"
        ? sourceOptions
        : (sourceOptions.sourceLabel ?? label);
    this.#verifySelectedPath =
      typeof sourceOptions === "string"
        ? false
        : (sourceOptions.verifySelectedPath ?? false);
    this.#source = new ArtifactFileSource(path, sourceLabel, admitted);
  }

  /** Read the carrier once and describe its entries. */
  protected abstract prepareEntries(
    signal?: AbortSignal,
  ): Promise<PositionalArtifactEntries<Metadata, Entry>>;

  /** Metadata from the same validated preparation that established entries and coverage. */
  protected get preparedFormatMetadata(): Metadata | undefined {
    return this.#prepared?.formatMetadata;
  }

  async prepareContainer(
    expectedSha256: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#scope.run(async () => {
      this.assertOpen(signal);
      if (this.#verifySelectedPath)
        await this.#source.bindSelectedPathSha256(expectedSha256, signal);
      else await this.#source.bindSha256(expectedSha256, signal);
    });
  }

  async *entries(
    signal?: AbortSignal,
    options?: ArtifactTraversalOptions,
  ): AsyncIterable<ArtifactEntry> {
    await this.#scope.run(async () => {
      this.assertOpen(signal);
      // The first preparation validates before publishing; cached traversals
      // still need their own freshness admission.
      if (this.#prepared !== undefined) await this.verifyCarrier(signal);
      await this.#preparation.run(
        signal,
        () => this.#prepare(signal),
        () => this.assertOpen(signal),
      );
    });
    this.assertOpen(signal);
    const prepared = this.#prepared;
    if (prepared === undefined)
      throw invariantViolation(
        "Positional artifact preparation did not complete",
      );
    options?.onCoverage?.({
      ...prepared.coverage,
      limitations: [...prepared.coverage.limitations],
    });
    let index = 0;
    for (const entry of prepared.entries.values()) {
      // Yield between batches so a large inventory does not hold the loop.
      if (index++ % 256 === 0) await setImmediate();
      this.assertOpen(signal);
      yield copyArtifactEntry(entry);
    }
    this.assertOpen(signal);
  }

  async open(entry: ArtifactEntry, signal?: AbortSignal): Promise<Readable> {
    return this.#scope.run(async () => {
      this.assertOpen(signal);
      const stored = this.#prepared?.entries.get(entry.adapterKey);
      assertProducedEntry(
        entry,
        stored,
        `${this.#label} entry does not match its owning inventory`,
      );
      if (stored.encrypted)
        throw new ArtifactReaderFailure(
          "unavailable",
          `Encrypted ${this.#label} member is unsupported: ${stored.path}`,
        );
      const { handle } = await this.verifyCarrier(signal);
      this.assertOpen(signal);
      if (stored.byteOffset === null || stored.declaredSize === null)
        throw this.noPhysicalRange(stored);
      const lifecycle = this.#lifecycle.member(signal);
      const { signal: streamSignal, cancellationFailure } = lifecycle;
      const source =
        stored.declaredSize === 0
          ? Readable.from([])
          : readFileHandleChunks(handle, {
              start: stored.byteOffset,
              end: stored.byteOffset + stored.declaredSize - 1,
              signal: streamSignal,
              cancellationFailure,
            });
      const output = this.#entryStream(stored, lifecycle);
      ownArtifactStream(source, output, {
        scope: this.#scope,
        signal: streamSignal,
        cancellationFailure,
        label: this.#label,
      });
      return output;
    });
  }

  async close(): Promise<void> {
    this.#lifecycle.close();
    await this.#scope.close();
    await this.#source.close();
    this.#prepared = undefined;
    this.#preparation.clear();
  }

  provenance(): readonly [] {
    return [];
  }

  /** Recheck the carrier's identity and borrow its descriptor. */
  protected verifyCarrier(
    signal?: AbortSignal,
  ): Promise<StableRegularFileDescriptor> {
    return this.#verifySelectedPath
      ? this.#source.readSelectedPath(signal)
      : this.#source.read(signal);
  }

  /** Refuse work once the caller cancels or close begins. */
  protected assertOpen(signal?: AbortSignal): void {
    assertArtifactReadActive(signal);
    if (this.#lifecycle.closed)
      throw new ArtifactReaderFailure(
        "unavailable",
        `${this.#label} reader is closed`,
      );
  }

  async #prepare(signal?: AbortSignal): Promise<void> {
    const prepared = await this.prepareEntries(signal);
    const entries = new Map(
      prepared.entries.map((entry) => [entry.adapterKey, entry] as const),
    );
    await this.verifyCarrier(signal);
    this.assertOpen(signal);
    this.#prepared = {
      entries,
      coverage: prepared.coverage,
      formatMetadata: prepared.formatMetadata,
    };
  }

  /** Format-specific failure when an entry without a physical byte range is opened. */
  protected noPhysicalRange(entry: Entry): ArtifactReaderFailure {
    return new ArtifactReaderFailure(
      "format",
      `${this.#label} member has no physical byte range: ${entry.path}`,
    );
  }

  /** Format-specific failure when a member stream ends before its declared byte count. */
  protected entryEndedEarly(entry: Entry): ArtifactReaderFailure {
    return new ArtifactReaderFailure(
      "integrity",
      `${this.#label} entry ended early: ${entry.path}`,
      { integrityCheck: "declared-size" },
    );
  }

  #entryStream(entry: Entry, lifecycle: ArtifactMemberLifecycle): Transform {
    const label = this.#label;
    let bytes = 0;
    const check = async (): Promise<void> => {
      if (bytes !== entry.declaredSize) throw this.entryEndedEarly(entry);
      await lifecycle.verify((signal) => this.verifyCarrier(signal));
    };
    return new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        callback(null, chunk);
      },
      flush(callback) {
        void check().then(
          () => callback(),
          (cause: unknown) =>
            callback(
              cause instanceof Error
                ? cause
                : new Error(`${label} read failed`, { cause }),
            ),
        );
      },
    });
  }
}
