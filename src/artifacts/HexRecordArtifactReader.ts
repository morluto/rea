import { Readable } from "node:stream";
import { setImmediate } from "node:timers/promises";

import type { HexRecordsMetadata } from "../domain/artifactFormatMetadata.js";
import {
  HEX_RECORD_ENCODING_LABELS,
  createHexRecordDecoder,
  type HexRecordFailure,
  type HexRecordImage,
} from "../domain/firmware/hexRecords.js";
import type { HexRecordEncoding } from "../domain/firmware/hexRecordSyntax.js";
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

const addressText = (address: number): string =>
  `0x${address.toString(16).padStart(8, "0")}`;

/** Decode Intel HEX or S-record text into address-contiguous region entries. */
export class HexRecordArtifactReader implements ArtifactReader {
  readonly #scope = new ArtifactResourceScope();
  readonly #entries = new Map<string, ArtifactEntry>();
  readonly #regions = new Map<string, Uint8Array>();
  readonly #streams = new Set<Readable>();
  readonly #source: ArtifactFileSource;
  readonly #label: string;
  #prepared: Promise<void> | undefined;
  #metadata: HexRecordsMetadata | undefined;
  #coverage: ArtifactReaderTraversal | undefined;
  #closing = false;

  constructor(
    path: string,
    readonly format: HexRecordEncoding,
    admitted?: StableRegularFileDescriptor,
  ) {
    this.#label = HEX_RECORD_ENCODING_LABELS[format];
    this.#source = new ArtifactFileSource(path, this.#label, admitted);
  }

  formatMetadata(): HexRecordsMetadata | undefined {
    return this.#metadata === undefined ? undefined : { ...this.#metadata };
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
      this.#prepared ??= this.#prepare(signal);
      await this.#prepared;
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
  }

  async open(entry: ArtifactEntry, signal?: AbortSignal): Promise<Readable> {
    return this.#scope.run(async () => {
      this.#assertOpen(signal);
      const stored = this.#entries.get(entry.adapterKey);
      const bytes = this.#regions.get(entry.adapterKey);
      if (
        stored === undefined ||
        bytes === undefined ||
        !sameArtifactEntry(entry, stored)
      )
        throw new ArtifactReaderFailure(
          "integrity",
          `${this.#label} entry does not match its owning inventory`,
        );
      // Decoded bytes are retained, so only the carrier identity is rechecked.
      await this.#source.read(signal);
      this.#assertOpen(signal);
      const output = Readable.from(this.#regionChunks(bytes, signal), {
        objectMode: false,
      });
      const onAbort = (): void => {
        output.destroy(
          new ArtifactReaderFailure(
            "cancelled",
            `${this.#label} region read cancelled`,
            { cause: signal?.reason },
          ),
        );
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      output.once("close", () => signal?.removeEventListener("abort", onAbort));
      output.on("error", () => undefined);
      this.#streams.add(output);
      output.once("close", () => this.#streams.delete(output));
      // Draining the scope must wait for the readable side, including an
      // abandoned consumer and an in-flight asynchronous chunk producer.
      void this.#scope
        .run(
          () =>
            new Promise<void>((resolve) => {
              output.once("close", () => resolve());
            }),
        )
        .catch((cause: unknown) =>
          output.destroy(
            cause instanceof Error
              ? cause
              : new ArtifactReaderFailure(
                  "unavailable",
                  `${this.#label} stream ownership failed`,
                  { cause },
                ),
          ),
        );
      return output;
    });
  }

  async *#regionChunks(
    bytes: Uint8Array,
    signal?: AbortSignal,
  ): AsyncIterable<Buffer> {
    // Keep cached bytes isolated from consumers without copying a whole
    // region for every open. Match descriptor reads' 64 KiB chunk size.
    for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
      await setImmediate();
      this.#assertOpen(signal);
      yield Buffer.from(bytes.subarray(offset, offset + 64 * 1024));
    }
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
    this.#regions.clear();
  }

  provenance(): readonly [] {
    return [];
  }

  #assertOpen(signal?: AbortSignal): void {
    assertArtifactReadActive(signal);
    if (this.#closing)
      throw new ArtifactReaderFailure(
        "unavailable",
        `${this.#label} reader is closed`,
      );
  }

  async #prepare(signal?: AbortSignal): Promise<void> {
    const image = await this.#decode(signal);
    let index = 0;
    for (const region of image.regions) {
      if (index % 256 === 0) await setImmediate();
      this.#assertOpen(signal);
      const entry = {
        path: `${addressText(region.start)}-${addressText(region.end)}.bin`,
        kind: "file" as const,
        declaredSize: region.bytes.length,
        compressedSize: null,
        executable: false,
        encrypted: false,
        byteOffset: null,
        declaredIntegrity: null,
        unpacked: false,
        limitations: [],
        adapterKey: `hex-records:${String(index)}`,
        formatMetadata: {
          kind: "hex-record-region" as const,
          start_address: region.start,
          end_address: region.end,
          length: region.bytes.length,
          record_count: region.recordCount,
          first_line: region.firstLine,
          last_line: region.lastLine,
        },
      } satisfies ArtifactEntry;
      this.#entries.set(entry.adapterKey, entry);
      this.#regions.set(entry.adapterKey, region.bytes);
      index += 1;
    }
    this.#metadata = image.metadata;
    if (!image.terminated || image.limitations.length > 0)
      this.#coverage = {
        status: image.terminated ? "complete" : "unknown",
        limitations: image.limitations,
      };
    await this.#source.read(signal);
  }

  async #decode(signal?: AbortSignal): Promise<HexRecordImage> {
    const { handle, initial } = await this.#source.read(signal);
    const decoder = createHexRecordDecoder(this.format, initial.size);
    if (!decoder.ok) throw this.#failure(decoder.error);
    // Reading only the admitted extent keeps decoded bytes within the arena.
    if (initial.size > 0)
      for await (const chunk of readFileHandleChunks(handle, {
        end: initial.size - 1,
        signal,
        cancellationFailure: (reason) =>
          new ArtifactReaderFailure(
            "cancelled",
            `${this.#label} read cancelled`,
            { cause: reason },
          ),
      }) as AsyncIterable<Buffer>) {
        this.#assertOpen(signal);
        const written = decoder.value.write(chunk);
        if (!written.ok) throw this.#failure(written.error);
      }
    const image = decoder.value.finish();
    if (!image.ok) throw this.#failure(image.error);
    return image.value;
  }

  #failure(failure: HexRecordFailure): ArtifactReaderFailure {
    return failure.kind === "format"
      ? new ArtifactReaderFailure(
          "format",
          `${this.#label} is malformed: ${failure.message}`,
        )
      : new ArtifactReaderFailure(
          "limit",
          `${this.#label} exceeds a fixed limit: ${failure.message}`,
          failure.boundary === undefined ? {} : { boundary: failure.boundary },
        );
  }
}
