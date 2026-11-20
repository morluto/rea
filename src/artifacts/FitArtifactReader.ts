import { ArtifactPreparation } from "./ArtifactPreparation.js";
import { Readable, Transform } from "node:stream";
import { setImmediate } from "node:timers/promises";

import type { FitMetadata } from "../domain/artifactFormatMetadata.js";
import { BinaryFormatFailure } from "../domain/binaryContainer.js";
import {
  FDT_MAX_HEADER_BYTES,
  readDevicetreeHeader,
} from "../domain/firmware/devicetreeHeader.js";
import { MAX_DEVICETREE_FILE_BYTES } from "../domain/firmware/devicetree.js";
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
import { ownArtifactStream } from "./OwnedArtifactStream.js";
import {
  createFitDigest,
  readFitStructure,
  type FitImageDeclaration,
} from "./fit/FitStructure.js";
import { readFileHandleChunks } from "../filesystem/readFileHandleChunks.js";
import { readFileHandleRange } from "../filesystem/readFileHandleRange.js";
import type { StableRegularFileDescriptor } from "../filesystem/RegularFile.js";

/** Inventory U-Boot FIT /images nodes as stored byte ranges without loading them. */
export class FitArtifactReader implements ArtifactReader {
  readonly format = "fit" as const;
  readonly #scope = new ArtifactResourceScope();
  #entries = new Map<string, ArtifactEntry>();
  readonly #streams = new Set<Readable>();
  readonly #path: string;
  readonly #source: ArtifactFileSource;
  readonly #preparation = new ArtifactPreparation();
  #metadata: FitMetadata | undefined;
  #coverage: ArtifactReaderTraversal | undefined;
  #closing = false;

  constructor(path: string, admitted?: StableRegularFileDescriptor) {
    this.#path = path;
    this.#source = new ArtifactFileSource(path, "FIT", admitted);
  }

  formatMetadata(): FitMetadata | undefined {
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
      await this.#source.read(signal);
    });
    if (this.#coverage !== undefined)
      options?.onCoverage?.({
        ...this.#coverage,
        limitations: [...this.#coverage.limitations],
      });
    let index = 0;
    for (const entry of this.#entries.values()) {
      if (index % 256 === 0) await setImmediate();
      index += 1;
      this.#assertOpen(signal);
      yield copyArtifactEntry(entry);
    }
    this.#assertOpen(signal);
  }

  async open(entry: ArtifactEntry, signal?: AbortSignal): Promise<Readable> {
    return this.#scope.run(async () => {
      this.#assertOpen(signal);
      const stored = this.#entries.get(entry.adapterKey);
      assertProducedEntry(
        entry,
        stored,
        "FIT entry does not match its owning inventory",
      );
      const { handle } = await this.#source.read(signal);
      this.#assertOpen(signal);
      if (stored.byteOffset === null || stored.declaredSize === null)
        throw new ArtifactReaderFailure(
          "format",
          `FIT image has no byte range: ${stored.path}`,
        );
      const source =
        stored.declaredSize === 0
          ? Readable.from([])
          : readFileHandleChunks(handle, {
              start: stored.byteOffset,
              end: stored.byteOffset + stored.declaredSize - 1,
              signal,
              cancellationFailure,
            });
      const output = this.#imageStream(stored, signal);
      ownArtifactStream(source, output, {
        scope: this.#scope,
        streams: this.#streams,
        signal,
        cancellationFailure,
        label: "FIT",
      });
      return output;
    });
  }

  async close(): Promise<void> {
    this.#closing = true;
    for (const stream of this.#streams)
      stream.destroy(
        new ArtifactReaderFailure("unavailable", "FIT reader closed"),
      );
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
      throw new ArtifactReaderFailure("unavailable", "FIT reader is closed");
  }

  async #prepare(signal?: AbortSignal): Promise<void> {
    const { handle, initial } = await this.#source.read(signal);
    const assertActive = (): void => this.#assertOpen(signal);
    const prefix = await readFileHandleRange(
      handle,
      0,
      FDT_MAX_HEADER_BYTES,
      assertActive,
    );
    let totalsize: number;
    try {
      ({ totalsize } = readDevicetreeHeader(prefix).header);
    } catch (cause) {
      if (cause instanceof BinaryFormatFailure)
        throw new ArtifactReaderFailure(
          "format",
          `FIT devicetree header: ${cause.message}`,
        );
      throw cause;
    }
    if (totalsize > initial.size)
      throw new ArtifactReaderFailure(
        "format",
        `FIT devicetree is truncated: totalsize ${String(totalsize)} exceeds the ${String(initial.size)}-byte file`,
      );
    if (totalsize > MAX_DEVICETREE_FILE_BYTES)
      throw new ArtifactReaderFailure(
        "limit",
        `FIT devicetree is ${String(totalsize)} bytes, above the fixed 16 MiB devicetree allowance; embedded image data this large is not supported (mkimage -E stores data externally). No runtime override.`,
        { boundary: "memory" },
      );
    // Only the devicetree is read; external image data stays on disk.
    const structure = readFitStructure(
      await readFileHandleRange(handle, 0, totalsize, assertActive),
      this.#path,
      initial.size,
    );
    const entries = new Map<string, ArtifactEntry>();
    let index = 0;
    for (const image of structure.images) {
      if (index % 256 === 0) await setImmediate();
      index += 1;
      this.#assertOpen(signal);
      await this.#verifyHashes(image, signal);
      const entry = {
        path: `images/${image.name}.bin`,
        sourcePath: `/images/${image.name}`,
        kind: "file" as const,
        declaredSize: image.size,
        compressedSize: null,
        executable: false,
        encrypted: false,
        byteOffset: image.start,
        declaredIntegrity: null,
        unpacked: false,
        limitations: image.limitations,
        adapterKey: `fit:${String(image.index)}`,
        formatMetadata: image.metadata,
      } satisfies ArtifactEntry;
      entries.set(entry.adapterKey, entry);
    }
    await this.#source.read(signal);
    this.#assertOpen(signal);
    this.#entries = entries;
    this.#metadata = structure.metadata;
    this.#coverage = {
      status: "complete",
      limitations: structure.limitations,
    };
  }

  /** One streamed pass per image feeds every supported digest. */
  async #verifyHashes(
    image: FitImageDeclaration,
    signal?: AbortSignal,
  ): Promise<void> {
    const digests = image.hashes.flatMap((hash) => {
      const digest = createFitDigest(hash.algo);
      return digest === undefined ? [] : [{ hash, digest }];
    });
    if (digests.length === 0) return;
    const { handle } = await this.#source.read(signal);
    if (image.size > 0)
      for await (const chunk of readFileHandleChunks(handle, {
        start: image.start,
        end: image.start + image.size - 1,
        signal,
        cancellationFailure,
      }) as AsyncIterable<Buffer>) {
        this.#assertOpen(signal);
        for (const { digest } of digests) digest.update(chunk);
      }
    for (const { hash, digest } of digests) {
      const computed = digest.digest();
      if (!computed.equals(hash.value))
        throw new ArtifactReaderFailure(
          "integrity",
          `FIT image ${image.name} ${hash.node} ${hash.algo} does not match: declared ${hash.value.toString("hex")}, computed ${computed.toString("hex")}`,
          { integrityCheck: "declared-digest" },
        );
    }
  }

  #imageStream(entry: ArtifactEntry, signal?: AbortSignal): Transform {
    let bytes = 0;
    const check = async (): Promise<void> => {
      if (bytes !== entry.declaredSize)
        throw new ArtifactReaderFailure(
          "format",
          `FIT image ended early: ${entry.path}`,
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
                : new Error("FIT read failed", { cause }),
            ),
        );
      },
    });
  }
}

const cancellationFailure = (reason: unknown): ArtifactReaderFailure =>
  new ArtifactReaderFailure("cancelled", "FIT read cancelled", {
    cause: reason,
  });
