import { Readable } from "node:stream";

import type { ArtifactFormatMetadata } from "../domain/artifactFormatMetadata.js";
import type { RegionDecodeFailure } from "../domain/firmware/regionDecoder.js";
import { runtimeRegfHiveFileAdmission } from "../config/regfHiveFileAdmission.js";
import type { AnalysisSettingsReader } from "../domain/analysisSettings.js";
import {
  createRegfDecoder,
  type RegfHiveFileAdmission,
  type RegfImage,
} from "../domain/windows/registryHive.js";
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
 * A hive file is its own content: the base block and bins describe the file,
 * not members inside it, so the root occurrence carries every fact and no
 * entries are enumerated.
 */
export class RegistryHiveArtifactReader implements ArtifactReader {
  readonly format = "regf-hive" as const;
  readonly #scope = new ArtifactResourceScope();
  readonly #source: ArtifactFileSource;
  readonly #admission: RegfHiveFileAdmission;
  #prepared: Promise<void> | undefined;
  #metadata: ArtifactFormatMetadata | undefined;
  #limitations: readonly string[] = [];
  #closing = false;

  constructor(
    path: string,
    admitted?: StableRegularFileDescriptor,
    environment: Readonly<Record<string, string | undefined>> = {},
    settings?: AnalysisSettingsReader,
  ) {
    this.#source = new ArtifactFileSource(
      path,
      "Windows registry hive",
      admitted,
    );
    this.#admission = runtimeRegfHiveFileAdmission(environment, settings);
  }

  formatMetadata(): ArtifactFormatMetadata | undefined {
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
    });
    // A hive declares no members, so the root occurrence is the whole
    // inventory; the coverage callback reports what its parse did not establish.
    options?.onCoverage?.(coverageOf(this.#limitations));
  }

  async open(entry: ArtifactEntry, _signal?: AbortSignal): Promise<Readable> {
    return this.#scope.run(async () => {
      throw new ArtifactReaderFailure(
        "unavailable",
        `Windows registry hive declares no member to open for ${entry.path}`,
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
        "Windows registry hive reader is closed",
      );
  }

  async #prepare(signal?: AbortSignal): Promise<void> {
    const image = await this.#decode(signal);
    this.#metadata = image.metadata;
    this.#limitations = image.limitations;
    await this.#source.read(signal);
  }

  async #decode(signal?: AbortSignal): Promise<RegfImage> {
    const { handle, initial } = await this.#source.read(signal);
    const decoder = createRegfDecoder(initial.size, this.#admission);
    if (!decoder.ok) throw this.#failure(decoder.error);
    if (initial.size > 0)
      for await (const chunk of readFileHandleChunks(handle, {
        end: initial.size - 1,
        signal,
        cancellationFailure: (reason) =>
          new ArtifactReaderFailure(
            "cancelled",
            "Windows registry hive read cancelled",
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

  #failure(failure: RegionDecodeFailure): ArtifactReaderFailure {
    if (failure.kind === "format")
      return new ArtifactReaderFailure(
        "format",
        `Windows registry hive is malformed: ${failure.message}`,
      );
    const fileLimit = failure.fileAdmission;
    return new ArtifactReaderFailure("limit", failure.message, {
      ...(failure.boundary === undefined ? {} : { boundary: failure.boundary }),
      ...(fileLimit === undefined
        ? {}
        : {
            admission: {
              kind: "regf-hive-file",
              maximumBytes: fileLimit.maximumBytes,
              source: fileLimit.source,
              fileLimit,
            },
          }),
    });
  }
}

const coverageOf = (limitations: readonly string[]): ArtifactReaderTraversal =>
  limitations.length === 0
    ? { status: "complete", limitations: [] }
    : { status: "unknown", limitations };
