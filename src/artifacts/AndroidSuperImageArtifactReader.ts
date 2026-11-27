import type { Readable } from "node:stream";

import {
  type AndroidSuperLimitParameter,
  readAndroidSuperImage,
} from "../domain/firmware/androidSuperImage.js";
import {
  ANDROID_SUPER_FORMAT,
  ANDROID_SUPER_PARTITION_RECORD_BYTES,
} from "../domain/firmware/androidSuperTables.js";
import type { AndroidSuperImageReaderLimits } from "../domain/artifactReaderLimits.js";
import type { AndroidSuperImageMetadata } from "../domain/formatMetadata/androidSuperImageMetadata.js";
import type { ParseFailureError } from "../domain/parseFailure.js";
import type { StableRegularFileDescriptor } from "../filesystem/RegularFile.js";
import {
  artifactReaderLimitFailure,
  ArtifactFileSource,
  artifactFormatFailure,
  ArtifactReaderFailure,
  ArtifactResourceScope,
  assertArtifactReadActive,
  type ArtifactEntry,
  type ArtifactReader,
  type ArtifactTraversalOptions,
} from "../resources/index.js";
import { readArtifactFileBytes } from "./ArtifactFileRange.js";
import { ArtifactPreparation } from "./ArtifactPreparation.js";

export class AndroidSuperImageArtifactReader implements ArtifactReader {
  readonly format = ANDROID_SUPER_FORMAT;
  readonly #scope = new ArtifactResourceScope();
  readonly #source: ArtifactFileSource;
  readonly #preparation = new ArtifactPreparation();
  #inventory:
    | Extract<
        Awaited<ReturnType<typeof readAndroidSuperImage>>,
        { ok: true }
      >["value"]
    | undefined;
  #closing = false;

  constructor(
    path: string,
    admitted?: StableRegularFileDescriptor,
    private readonly limits?: AndroidSuperImageReaderLimits,
  ) {
    this.#source = new ArtifactFileSource(
      path,
      "Android super image",
      admitted,
    );
  }

  formatMetadata(): AndroidSuperImageMetadata | undefined {
    return structuredClone(this.#inventory?.metadata);
  }

  async *entries(
    signal?: AbortSignal,
    options?: ArtifactTraversalOptions,
  ): AsyncIterable<ArtifactEntry> {
    const inventory = await this.#scope.run(async () => {
      this.#assertOpen(signal);
      await this.#preparation.run(
        signal,
        () => this.#prepare(signal),
        () => this.#assertOpen(signal),
      );
      this.#assertOpen(signal);
      await this.#source.read(signal);
      return this.#inventory!;
    });
    for (const { record_offset, ...partition } of inventory.partitions) {
      this.#assertOpen(signal);
      const slot =
        partition.slot === null ? "template" : `slot-${String(partition.slot)}`;
      const path = `${slot}/${partition.name}`;
      yield {
        path,
        sourcePath: partition.name,
        kind: "metadata",
        declaredSize: ANDROID_SUPER_PARTITION_RECORD_BYTES,
        compressedSize: null,
        executable: false,
        encrypted: false,
        byteOffset: record_offset,
        declaredIntegrity: null,
        unpacked: false,
        limitations: [],
        adapterKey: path,
        formatMetadata: structuredClone(partition),
      };
    }
    options?.onCoverage?.({
      status: inventory.coverage,
      limitations: inventory.limitations,
    });
    this.#assertOpen(signal);
  }

  async open(entry: ArtifactEntry, signal?: AbortSignal): Promise<Readable> {
    this.#assertOpen(signal);
    throw new ArtifactReaderFailure(
      "unavailable",
      `Android super inventory cannot open partition content for ${entry.path}`,
    );
  }

  provenance(): readonly [] {
    return [];
  }

  async close(): Promise<void> {
    this.#closing = true;
    await this.#scope.close();
    await this.#source.close();
    this.#inventory = undefined;
    this.#preparation.clear();
  }

  #assertOpen(signal?: AbortSignal): void {
    assertArtifactReadActive(signal);
    if (this.#closing)
      throw new ArtifactReaderFailure(
        "unavailable",
        "Android super image reader is closed",
      );
  }

  async #prepare(signal?: AbortSignal): Promise<void> {
    const { handle, initial } = await this.#source.read(signal);
    const inventory = await readAndroidSuperImage(
      initial.size,
      (offset, length) =>
        readArtifactFileBytes(
          this.format,
          handle,
          offset,
          length,
          initial.size,
          signal,
        ),
      this.limits,
    );
    await this.#source.read(signal);
    this.#assertOpen(signal);
    if (!inventory.ok) throw readerFailure(inventory.error);
    this.#inventory = inventory.value;
  }
}

const readerFailure = (cause: ParseFailureError): ArtifactReaderFailure => {
  const failure = cause.failure;
  if (failure.kind !== "limit")
    return artifactFormatFailure(failure, { cause });
  const parameter = failure.limit.name as AndroidSuperLimitParameter;
  return artifactReaderLimitFailure(
    parameter,
    failure.limit.maximum,
    parameter === "artifact_limits.android_super_image.metadata_bytes"
      ? "bytes"
      : "count",
    failure.limit.required,
  );
};
