import { Readable, Transform, pipeline } from "node:stream";
import { setImmediate } from "node:timers/promises";

import {
  ArtifactReaderFailure,
  copyArtifactEntry,
  sameArtifactEntry,
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

/** An entry whose bytes are one range of the carrier. */
export type PositionalArtifactEntry = ArtifactEntry & {
  readonly byteOffset: number;
  readonly declaredSize: number;
};

/** The entries one preparation established and the coverage to report. */
export interface PositionalArtifactEntries {
  readonly entries: readonly PositionalArtifactEntry[];
  /** Undefined when coverage is complete without limitations. */
  readonly coverage: ArtifactReaderTraversal | undefined;
}

/**
 * Serve entries that are byte ranges of one carrier file. Preparation runs
 * once; every traversal, open and completed entry stream rechecks the
 * carrier's identity, and close retires open streams before the carrier.
 * Encrypted entries are listed but never opened.
 */
export abstract class PositionalArtifactReader implements ArtifactReader {
  abstract readonly format: ArtifactReader["format"];
  readonly #scope = new ArtifactResourceScope();
  readonly #entries = new Map<string, PositionalArtifactEntry>();
  readonly #streams = new Set<Readable>();
  readonly #label: string;
  readonly #source: ArtifactFileSource;
  #prepared: Promise<void> | undefined;
  #coverage: ArtifactReaderTraversal | undefined;
  #closing = false;

  constructor(
    path: string,
    label: string,
    admitted?: StableRegularFileDescriptor,
  ) {
    this.#label = label;
    this.#source = new ArtifactFileSource(path, label, admitted);
  }

  /** Read the carrier once and describe its entries. */
  protected abstract prepareEntries(
    signal?: AbortSignal,
  ): Promise<PositionalArtifactEntries>;

  async prepareContainer(
    expectedSha256: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#scope.run(async () => {
      this.assertOpen(signal);
      await this.#source.bindSha256(expectedSha256, signal);
    });
  }

  async *entries(
    signal?: AbortSignal,
    options?: ArtifactTraversalOptions,
  ): AsyncIterable<ArtifactEntry> {
    await this.#scope.run(async () => {
      this.assertOpen(signal);
      this.#prepared ??= this.#prepare(signal);
      await this.#prepared;
      await this.#source.read(signal);
    });
    this.assertOpen(signal);
    if (this.#coverage !== undefined)
      options?.onCoverage?.({
        ...this.#coverage,
        limitations: [...this.#coverage.limitations],
      });
    let index = 0;
    for (const entry of this.#entries.values()) {
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
      const stored = this.#entries.get(entry.adapterKey);
      if (stored === undefined || !sameArtifactEntry(entry, stored))
        throw new ArtifactReaderFailure(
          "integrity",
          `${this.#label} entry does not match its owning inventory`,
        );
      if (stored.encrypted)
        throw new ArtifactReaderFailure(
          "unavailable",
          `Encrypted ${this.#label} member is unsupported: ${stored.path}`,
        );
      const { handle } = await this.#source.read(signal);
      this.assertOpen(signal);
      const source =
        stored.declaredSize === 0
          ? Readable.from([])
          : readFileHandleChunks(handle, {
              start: stored.byteOffset,
              end: stored.byteOffset + stored.declaredSize - 1,
              signal,
              cancellationFailure: (reason) =>
                new ArtifactReaderFailure(
                  "cancelled",
                  `${this.#label} read cancelled`,
                  { cause: reason },
                ),
            });
      const output = this.#entryStream(stored, signal);
      // Retirement can destroy the stream before its consumer listens.
      output.on("error", () => undefined);
      this.#streams.add(output);
      let producerComplete = false;
      const onAbort = (): void => {
        // Preserve active read/validation errors; after production, the caller
        // still owns buffered bytes and cancellation must retire that result.
        if (!producerComplete || output.destroyed) return;
        output.destroy(
          new ArtifactReaderFailure(
            "cancelled",
            `${this.#label} read cancelled`,
            { cause: signal?.reason },
          ),
        );
      };
      // Writable completion can leave unread bytes buffered on the readable
      // side, so the stream stays owned until that side closes too.
      const retired = new Promise<void>((resolve) => {
        output.once("close", () => {
          this.#streams.delete(output);
          signal?.removeEventListener("abort", onAbort);
          resolve();
        });
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
      void this.#scope
        .run(async () => {
          await Promise.all([
            new Promise<void>((resolve) => {
              pipeline(source, output, () => {
                producerComplete = true;
                if (signal?.aborted) onAbort();
                resolve();
              });
            }),
            retired,
          ]);
        })
        .catch((cause: unknown) =>
          output.destroy(
            cause instanceof Error
              ? cause
              : new Error(`${this.#label} stream ownership failed`, {
                  cause,
                }),
          ),
        );
      return output;
    });
  }

  async close(): Promise<void> {
    this.#closing = true;
    for (const stream of this.#streams)
      stream.destroy(
        new ArtifactReaderFailure(
          "unavailable",
          `${this.#label} reader closed`,
        ),
      );
    await this.#scope.close();
    await this.#source.close();
    this.#entries.clear();
  }

  provenance(): readonly [] {
    return [];
  }

  /** Recheck the carrier's identity and borrow its descriptor. */
  protected verifyCarrier(
    signal?: AbortSignal,
  ): Promise<StableRegularFileDescriptor> {
    return this.#source.read(signal);
  }

  /** Refuse work once the caller cancels or close begins. */
  protected assertOpen(signal?: AbortSignal): void {
    assertArtifactReadActive(signal);
    if (this.#closing)
      throw new ArtifactReaderFailure(
        "unavailable",
        `${this.#label} reader is closed`,
      );
  }

  async #prepare(signal?: AbortSignal): Promise<void> {
    const { entries, coverage } = await this.prepareEntries(signal);
    for (const entry of entries) this.#entries.set(entry.adapterKey, entry);
    this.#coverage = coverage;
  }

  #entryStream(
    entry: PositionalArtifactEntry,
    signal?: AbortSignal,
  ): Transform {
    const label = this.#label;
    let bytes = 0;
    const check = async (): Promise<void> => {
      if (bytes !== entry.declaredSize)
        throw new ArtifactReaderFailure(
          "integrity",
          `${label} entry ended early: ${entry.path}`,
        );
      await this.#source.read(signal);
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
