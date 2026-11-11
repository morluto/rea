import { Readable } from "node:stream";

import { setImmediate } from "node:timers/promises";

import type { PrefetchMetadataFacts } from "../domain/artifactFormatMetadata.js";
import { readFileHandleRange } from "../filesystem/readFileHandleRange.js";
import type { StableRegularFileDescriptor } from "../filesystem/RegularFile.js";
import {
  PREFETCH_MAX_FILE_BYTES,
  parsePrefetchFile,
} from "../domain/windows/prefetchFormat.js";
import {
  assertArtifactReadActive,
  artifactReadCancelledBy,
} from "./ArtifactFileOperation.js";
import { ArtifactFileSource } from "./ArtifactFileSource.js";
import {
  ArtifactReaderFailure,
  type ArtifactEntry,
  type ArtifactReader,
  type ArtifactTraversalOptions,
} from "./ArtifactReader.js";
import { ArtifactResourceScope } from "./ArtifactResourceScope.js";

/** Windows Prefetch file whose header facts become the root occurrence. */
export class WindowsPrefetchArtifactReader implements ArtifactReader {
  readonly format = "windows-prefetch" as const;
  readonly #scope = new ArtifactResourceScope();
  readonly #path: string;
  readonly #source: ArtifactFileSource;
  #prepared:
    | { signal: AbortSignal | undefined; promise: Promise<void> }
    | undefined;
  #metadata: PrefetchMetadataFacts | undefined;
  #closing = false;

  constructor(path: string, admitted?: StableRegularFileDescriptor) {
    this.#path = path;
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
      for (;;) {
        const pending = (this.#prepared ??= {
          signal,
          promise: this.#prepare(signal),
        });
        try {
          await pending.promise;
          break;
        } catch (cause: unknown) {
          // A preparation bound to another caller's signal stays cached when
          // that caller aborts, so this traversal retries under its own signal
          // instead of inheriting a cancellation it never received.
          if (this.#prepared === pending) this.#prepared = undefined;
          if (
            pending.signal !== signal &&
            signal?.aborted !== true &&
            artifactReadCancelledBy(cause, pending.signal)
          ) {
            this.#assertOpen(signal);
            continue;
          }
          throw cause;
        }
      }
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
    if (initial.size > PREFETCH_MAX_FILE_BYTES)
      throw new ArtifactReaderFailure(
        "limit",
        `Windows Prefetch files are capped at 1 MiB when built; ${String(initial.size)} bytes is above the ${String(PREFETCH_MAX_FILE_BYTES)}-byte allowance.`,
        { boundary: "memory" },
      );
    const bytes = await readFileHandleRange(
      handle,
      0,
      initial.size,
      assertActive,
    );
    const parsed = parsePrefetchFile(bytes);
    if (!parsed.ok)
      // An intact variant this reader does not decode is unavailable, not
      // malformed; only a genuine decode failure is a format failure.
      throw new ArtifactReaderFailure(
        parsed.error.kind === "unsupported" ? "unavailable" : parsed.error.kind,
        parsed.error.message,
      );
    const metadata = parsed.value;
    // Accept the source identity before exposing any parsed fact, so a carrier
    // that changed after the read cannot leave metadata from an unverified file.
    await this.#source.read(signal);
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
