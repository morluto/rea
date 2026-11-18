import { setImmediate } from "node:timers/promises";
import type { Readable } from "node:stream";

import {
  macosFseventsMetadataSchema,
  type ArtifactFormatMetadata,
} from "../domain/artifactFormatMetadata.js";
import {
  FSEVENTS_MAX_DECOMPRESSED_BYTES,
  FSEVENTS_MAX_FILE_BYTES,
  FSEVENTS_MAX_INLINE_PATH_BYTES,
  parseMacosFseventsBytes,
  type MacosFseventsDecodeFailure,
  type MacosFseventsInventory,
  type MacosFseventsLimitKind,
} from "../domain/apple/macosFsevents.js";
import { readFileHandleChunks } from "../filesystem/readFileHandleChunks.js";
import type { StableRegularFileDescriptor } from "../filesystem/RegularFile.js";
import {
  ArtifactFileSource,
  artifactFixedLimitFailure,
  ArtifactReaderFailure,
  ArtifactResourceScope,
  assertArtifactReadActive,
  type ArtifactEntry,
  type ArtifactFixedLimit,
  type ArtifactReader,
  type ArtifactReaderTraversal,
  type ArtifactTraversalOptions,
} from "../resources/index.js";
import { ArtifactPreparation } from "./ArtifactPreparation.js";

/**
 * A macOS `.fseventsd` store file is its own content: its DLS blocks describe
 * recorded filesystem events rather than nested files to extract, so facts are
 * attached directly to the root occurrence.
 */
export class MacosFseventsArtifactReader implements ArtifactReader {
  readonly format = "macos-fsevents" as const;
  readonly #scope = new ArtifactResourceScope();
  readonly #source: ArtifactFileSource;
  readonly #preparation = new ArtifactPreparation();
  #metadata: ArtifactFormatMetadata | undefined;
  #limitations: readonly string[] = [];
  #closing = false;

  constructor(path: string, admitted?: StableRegularFileDescriptor) {
    this.#source = new ArtifactFileSource(
      path,
      "macOS FSEvents store",
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
    options?.onCoverage?.(coverageOf(this.#limitations));
    await setImmediate();
    this.#assertOpen(signal);
  }

  async open(entry: ArtifactEntry, _signal?: AbortSignal): Promise<Readable> {
    return this.#scope.run(async () => {
      throw new ArtifactReaderFailure(
        "unavailable",
        `macOS FSEvents store declares no member to open for ${entry.path}`,
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
        "macOS FSEvents store reader is closed",
      );
  }

  async #prepare(signal?: AbortSignal): Promise<void> {
    const inventory = await this.#decode(signal);
    await this.#source.read(signal);
    this.#metadata = macosFseventsMetadataSchema.parse(inventory.metadata);
    this.#limitations = inventory.limitations;
  }

  async #decode(signal?: AbortSignal): Promise<MacosFseventsInventory> {
    const { handle, initial } = await this.#source.read(signal);
    if (initial.size > FSEVENTS_MAX_FILE_BYTES)
      throw this.#failure({
        kind: "limit",
        limitKind: "input-bytes",
        limitBytes: FSEVENTS_MAX_FILE_BYTES,
        boundary: "file-size",
        message: `file is ${String(initial.size)} bytes (maximum ${String(FSEVENTS_MAX_FILE_BYTES)})`,
      });
    const chunks: Buffer[] = [];
    let bufferedBytes = 0;
    if (initial.size > 0) {
      for await (const chunk of readFileHandleChunks(handle, {
        end: initial.size - 1,
        signal,
        cancellationFailure: (reason) =>
          new ArtifactReaderFailure(
            "cancelled",
            "macOS FSEvents store read cancelled",
            { cause: reason },
          ),
      }) as AsyncIterable<Buffer>) {
        this.#assertOpen(signal);
        if (bufferedBytes + chunk.length > FSEVENTS_MAX_FILE_BYTES)
          throw this.#failure({
            kind: "limit",
            limitKind: "input-bytes",
            limitBytes: FSEVENTS_MAX_FILE_BYTES,
            boundary: "file-size",
            message: `buffered input exceeds ${String(FSEVENTS_MAX_FILE_BYTES)} bytes`,
          });
        chunks.push(chunk);
        bufferedBytes += chunk.length;
      }
    }
    const parsed = parseMacosFseventsBytes(
      Buffer.concat(chunks, bufferedBytes),
    );
    if (!parsed.ok) throw this.#failure(parsed.error);
    return parsed.value;
  }

  #failure(failure: MacosFseventsDecodeFailure): ArtifactReaderFailure {
    if (failure.kind === "format")
      return new ArtifactReaderFailure(
        "format",
        `macOS FSEvents store is malformed: ${failure.message}`,
      );
    return artifactFixedLimitFailure(
      fixedAllowanceFor(failure.limitKind, failure.limitBytes),
      `macOS FSEvents store exceeds a fixed limit: ${failure.message}`,
      failure.boundary,
    );
  }
}

const FIXED_ALLOWANCES: Record<
  MacosFseventsLimitKind,
  { readonly name: string; readonly kind: "input" | "parser" }
> = {
  "input-bytes": {
    name: "macOS FSEvents compressed or raw store input",
    kind: "input",
  },
  "decompressed-bytes": {
    name: "macOS FSEvents decompressed Disk Log Stream",
    kind: "parser",
  },
  "sample-path-bytes": {
    name: "macOS FSEvents sampled inline path strings",
    kind: "parser",
  },
};

const fixedAllowanceFor = (
  limitKind: MacosFseventsLimitKind,
  fallbackBytes: number,
): ArtifactFixedLimit => {
  const entry = FIXED_ALLOWANCES[limitKind];
  const limit =
    limitKind === "input-bytes"
      ? FSEVENTS_MAX_FILE_BYTES
      : limitKind === "decompressed-bytes"
        ? FSEVENTS_MAX_DECOMPRESSED_BYTES
        : FSEVENTS_MAX_INLINE_PATH_BYTES || fallbackBytes;
  return {
    name: entry.name,
    kind: entry.kind,
    limit,
    unit: "bytes",
  };
};

const coverageOf = (limitations: readonly string[]): ArtifactReaderTraversal =>
  limitations.length === 0
    ? { status: "complete", limitations: [] }
    : { status: "unknown", limitations };
