import { Readable } from "node:stream";

import { setImmediate } from "node:timers/promises";

import type { PrefetchMetadataFacts } from "../domain/formatMetadata/androidAndSystemMetadata.js";
import { readFileHandleRange } from "../filesystem/readFileHandleRange.js";
import type { StableRegularFileDescriptor } from "../filesystem/RegularFile.js";
import {
  PREFETCH_HEADER_READ_BYTES,
  parsePrefetchHeader,
} from "../domain/windows/prefetchFormat.js";
import {
  ArtifactFileSource,
  ArtifactReaderFailure,
  ArtifactResourceScope,
  artifactParseFailure,
  assertArtifactReadActive,
  type ArtifactEntry,
  type ArtifactReader,
  type ArtifactTraversalOptions,
} from "../resources/index.js";
import { ArtifactPreparation } from "./ArtifactPreparation.js";

/** Windows Prefetch file whose header facts become the root occurrence. */
export class WindowsPrefetchArtifactReader implements ArtifactReader {
  readonly format = "windows-prefetch" as const;
  readonly #scope = new ArtifactResourceScope();
  readonly #source: ArtifactFileSource;
  readonly #preparation = new ArtifactPreparation();
  #metadata: PrefetchMetadataFacts | undefined;
  #closing = false;

  constructor(path: string, admitted?: StableRegularFileDescriptor) {
    this.#source = new ArtifactFileSource(path, "Windows Prefetch", admitted);
  }

  formatMetadata(): PrefetchMetadataFacts | undefined {
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
    let limitations: readonly string[] = [];
    await this.#scope.run(async () => {
      this.#assertOpen(signal);
      await this.#preparation.run(
        signal,
        () => this.#prepare(signal),
        () => this.#assertOpen(signal),
      );
      await this.#source.read(signal);
      limitations = this.#limitations;
    });
    if (limitations.length > 0)
      options?.onCoverage?.({
        status: "complete",
        limitations: [...limitations],
      });
    // No members: the root occurrence carries every header fact, so the loop
    // body is empty and only cancellation can interrupt it.
    await setImmediate();
    this.#assertOpen(signal);
  }

  async open(_entry: ArtifactEntry, _signal?: AbortSignal): Promise<Readable> {
    // Members are never yielded, so no entry can be opened.
    throw new ArtifactReaderFailure(
      "unavailable",
      "Windows Prefetch inventory holds no openable members",
    );
  }

  async close(): Promise<void> {
    this.#closing = true;
    await this.#scope.close();
    await this.#source.close();
  }

  provenance(): readonly [] {
    return [];
  }

  #limitations: readonly string[] = [];

  #assertOpen(signal?: AbortSignal): void {
    assertArtifactReadActive(signal);
    if (this.#closing)
      throw new ArtifactReaderFailure(
        "unavailable",
        "Windows Prefetch reader is closed",
      );
  }

  async #prepare(signal?: AbortSignal): Promise<void> {
    const { handle, initial } = await this.#source.read(signal);
    const assertActive = (): void => this.#assertOpen(signal);
    const length = Math.min(initial.size, PREFETCH_HEADER_READ_BYTES);
    const bytes = await readFileHandleRange(handle, 0, length, assertActive);
    // Verify the source before classifying the bytes. A source that changed
    // during the read takes precedence over the recorded format facts.
    await this.#source.read(signal);
    if (bytes.length !== length)
      throw new ArtifactReaderFailure(
        "integrity",
        `Windows Prefetch header read ended at ${String(bytes.length)} of ${String(length)} bytes`,
        { integrityCheck: "read-coverage" },
      );
    const parsed = parsePrefetchHeader(bytes, initial.size);
    if (!parsed.ok) throw artifactParseFailure(parsed.error, signal);
    const metadata = parsed.value;
    this.#metadata = {
      kind: "windows-prefetch",
      version: metadata.version,
      file_bytes: metadata.fileBytes,
      declared_file_bytes: metadata.declaredFileBytes,
      executable_name: metadata.executableName,
      executable_path_hash: metadata.executablePathHash,
      run_count: metadata.runCount,
      run_time_slots: metadata.runTimeSlots,
    };
    // The file is its own content, so the root occurrence carries these facts
    // and there are no members to enumerate.
    this.#limitations = [...metadata.limitations];
  }
}
