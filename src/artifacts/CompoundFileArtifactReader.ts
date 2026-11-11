import { once } from "node:events";
import { PassThrough, Readable } from "node:stream";

import type { CompoundFileMetadata } from "../domain/artifactFormatMetadata.js";
import type { RegionDecodeFailure } from "../domain/firmware/regionDecoder.js";
import {
  createCompoundFileDecoder,
  type CompoundFileDirectoryEntry,
  type CompoundFileImage,
} from "../domain/windows/compoundFile.js";
import {
  ArtifactReaderFailure,
  copyArtifactEntry,
  type ArtifactEntry,
  type ArtifactReader,
  type ArtifactTraversalOptions,
} from "./ArtifactReader.js";
import { ArtifactResourceScope } from "./ArtifactResourceScope.js";
import { normalizeArtifactPath } from "./ArtifactPaths.js";
import {
  assertArtifactReadActive,
  artifactReadCancelledBy,
} from "./ArtifactFileOperation.js";
import { ArtifactFileSource } from "./ArtifactFileSource.js";
import { readFileHandleChunks } from "../filesystem/readFileHandleChunks.js";
import type { StableRegularFileDescriptor } from "../filesystem/RegularFile.js";

/**
 * A compound file's directories and allocation tables describe containers
 * inside the file, so every directory entry is one inventory occurrence. A
 * stream's bytes are listed but not interpreted: what a Jump List's DestList or
 * a shell link's target means is an artifact-specific question for later steps.
 */
export class CompoundFileArtifactReader implements ArtifactReader {
  readonly format = "compound-file" as const;
  readonly #scope = new ArtifactResourceScope();
  readonly #source: ArtifactFileSource;
  readonly #entries = new Map<string, ArtifactEntry>();
  /** Logical path to source ordinal, so `open` finds the entry it was given. */
  readonly #byPath = new Map<string, string>();
  #prepared:
    | { signal: AbortSignal | undefined; promise: Promise<void> }
    | undefined;
  #metadata: CompoundFileMetadata | undefined;
  #limitations: readonly string[] = [];
  #closing = false;

  constructor(path: string, admitted?: StableRegularFileDescriptor) {
    this.#source = new ArtifactFileSource(path, "compound file", admitted);
  }

  formatMetadata(): CompoundFileMetadata | undefined {
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
    });
    // Only an entry without a name or outside the root's tree has no path; the
    // parse already names each of those in its limitations.
    options?.onCoverage?.(
      this.#limitations.length === 0
        ? { status: "complete", limitations: [] }
        : { status: "unknown", limitations: [...this.#limitations] },
    );
    for (const entry of this.#entries.values()) {
      this.#assertOpen(signal);
      yield copyArtifactEntry(entry);
    }
    this.#assertOpen(signal);
  }

  async open(entry: ArtifactEntry, signal?: AbortSignal): Promise<Readable> {
    return this.#scope.run(async () => {
      this.#assertOpen(signal);
      const key = this.#byPath.get(entry.path);
      const stored = key === undefined ? undefined : this.#entries.get(key);
      if (stored === undefined || !sameRange(entry, stored))
        throw new ArtifactReaderFailure(
          "integrity",
          `compound file entry does not match its owning inventory: ${entry.path}`,
        );
      // A zero-byte stream has no sector range and opens as an empty stream;
      // requiring a byte offset here would make every empty file unreadable.
      if (stored.declaredSize === 0) return Readable.from([]);
      if (stored.byteOffset === null || stored.declaredSize === null)
        throw new ArtifactReaderFailure(
          "format",
          `compound file stream has no contiguous byte range: ${stored.path}`,
        );
      const { handle } = await this.#source.read(signal);
      this.#assertOpen(signal);
      const label = "compound file";
      const source = readFileHandleChunks(handle, {
        start: stored.byteOffset,
        end: stored.byteOffset + stored.declaredSize - 1,
        signal,
        cancellationFailure: (reason) =>
          new ArtifactReaderFailure("cancelled", `${label} read cancelled`, {
            cause: reason,
          }),
      });
      const output = new PassThrough();
      // Retirement can destroy the stream before its consumer listens.
      output.on("error", () => undefined);
      let delivered = 0;
      // A carrier truncated or rewritten after the pre-read would otherwise
      // publish whatever bytes happened to arrive, so the delivered length and
      // the source identity are checked once the range has been consumed. The
      // check runs at the end of the stream instead of before the first write:
      // a near-ceiling member must not be held resident in full to be delivered.
      const verify = async (): Promise<void> => {
        this.#assertOpen(signal);
        if (delivered !== stored.declaredSize)
          throw new ArtifactReaderFailure(
            "integrity",
            `${label} entry ended early: ${stored.path}`,
          );
        await this.#source.read(signal);
      };
      void this.#scope
        .run(async () => {
          for await (const chunk of source as AsyncIterable<Buffer>) {
            delivered += chunk.length;
            if (!output.write(chunk)) await once(output, "drain");
          }
          await verify();
          output.end();
        })
        .catch((cause: unknown) =>
          output.destroy(
            cause instanceof Error
              ? cause
              : new Error(`${label} read failed`, { cause }),
          ),
        );
      return output;
    });
  }

  async close(): Promise<void> {
    this.#closing = true;
    await this.#scope.close();
    await this.#source.close();
    this.#entries.clear();
    this.#byPath.clear();
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
        "compound file reader is closed",
      );
  }

  async #prepare(signal?: AbortSignal): Promise<void> {
    const image = await this.#decode(signal);
    this.#metadata = image.metadata;
    this.#limitations = image.limitations;
    // Directory entries are keyed by their source ordinal, not by path: a
    // damaged tree can hold two entries with the same logical path, and one
    // must not silently replace the other.
    const claimed = new Set<string>();
    for (const entry of image.entries) {
      const artifact = toArtifactEntry(entry);
      if (artifact === null) continue;
      const key = String(entry.index);
      const placed = claimPath(artifact, claimed, entry.index);
      this.#entries.set(key, placed);
      this.#byPath.set(placed.path, key);
    }
    await this.#source.read(signal);
  }

  async #decode(signal?: AbortSignal): Promise<CompoundFileImage> {
    const { handle, initial } = await this.#source.read(signal);
    const decoder = createCompoundFileDecoder(initial.size);
    if (!decoder.ok) throw this.#failure(decoder.error);
    if (initial.size > 0)
      for await (const chunk of readFileHandleChunks(handle, {
        end: initial.size - 1,
        signal,
        cancellationFailure: (reason) =>
          new ArtifactReaderFailure(
            "cancelled",
            "compound file read cancelled",
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
    return failure.kind === "format"
      ? new ArtifactReaderFailure(
          "format",
          `compound file is malformed: ${failure.message}`,
        )
      : new ArtifactReaderFailure(
          "limit",
          `compound file exceeds a fixed limit: ${failure.message}`,
          failure.boundary === undefined ? {} : { boundary: failure.boundary },
        );
  }
}

const sameRange = (entry: ArtifactEntry, stored: ArtifactEntry): boolean =>
  entry.kind === stored.kind &&
  entry.byteOffset === stored.byteOffset &&
  entry.declaredSize === stored.declaredSize;

/**
 * The root storage has no name of its own and two entries can share a logical
 * path, so an entry whose path is already claimed by another is listed under
 * its source ordinal instead. The same applies to a name that is not a single
 * safe path component: the raw declared name stays in `sourcePath`.
 *
 * Claiming compares the normalized identity, not the raw spelling: the
 * inventory registry normalizes NFC, so two canonically equivalent names would
 * otherwise both pass here and abort the whole inventory downstream.
 */
const claimPath = (
  entry: ArtifactEntry,
  claimed: Set<string>,
  index: number,
): ArtifactEntry => {
  const identity = normalizedIdentity(entry.path);
  const collides =
    entry.path === "" || identity === null || claimed.has(identity);
  let path = entry.path;
  if (collides) {
    // A member may literally be named `entry-<ordinal>`, so the fallback is
    // probed against the same set; reusing a claimed fallback would overwrite
    // that member's path and make open() resolve the wrong range.
    const base = `entry-${String(index)}`;
    path = base;
    for (let suffix = 2; claimed.has(path); suffix += 1)
      path = `${base}-${String(suffix)}`;
  }
  claimed.add(collides ? path : (identity as string));
  if (!collides) return entry;
  return {
    ...entry,
    path,
    ...(entry.path === "" ? {} : { sourcePath: entry.path }),
    limitations: [
      ...entry.limitations,
      "This entry's declared name is not a single safe path component, or another entry already claimed its logical path, so it is listed under its source ordinal; the declared name, when it has one, is retained in sourcePath.",
    ],
  };
};

/** The path identity the inventory registry compares after NFC normalization. */
const normalizedIdentity = (path: string): string | null => {
  try {
    return normalizeArtifactPath(path);
  } catch {
    return null;
  }
};

const toArtifactEntry = (
  entry: CompoundFileDirectoryEntry,
): ArtifactEntry | null => {
  const path = entry.path;
  // The root storage is the container itself, not a member of it. An entry
  // outside the root's tree keeps its declared facts under its source ordinal;
  // the parse counts orphans.
  if (entry.type === "root-storage") return null;
  if (entry.type !== "storage" && entry.type !== "stream") return null;
  const unnamed = path === null && entry.name === null;
  const limitation = (): string[] => {
    if (unnamed)
      return [
        "This entry declares no valid name, so it is listed under its source ordinal; its type, size and allocation facts are kept.",
      ];
    if (path === null)
      return [
        "This entry is not reachable from the root storage, so it has no logical path; its declared name and facts are kept.",
      ];
    return [];
  };
  if (entry.type === "storage") {
    return {
      path: path ?? "",
      kind: "directory",
      declaredSize: 0,
      compressedSize: null,
      executable: false,
      encrypted: false,
      byteOffset: null,
      declaredIntegrity: null,
      unpacked: false,
      limitations: limitation(),
      adapterKey: `compound-file/${String(entry.index)}`,
    };
  }
  const limitations: string[] = limitation();
  // A mini stream needs the root storage's chain and the mini FAT walked; a
  // split chain has no single range. Both are listed as declarations rather
  // than as content this step claims to reproduce.
  if (entry.storage === "mini")
    limitations.push(
      "This stream is smaller than the mini stream cutoff and lives in the root storage's mini stream; its byte range is not resolved in this step.",
    );
  if (entry.storage === "empty" && entry.streamSize > 0)
    limitations.push(
      "This stream declares bytes but its allocation is unresolved, so it has no byte range in this step.",
    );
  if (entry.storage !== "mini" && entry.contiguous === false)
    limitations.push(
      "This stream's FAT chain is not contiguous, so it has no single byte range in this step.",
    );
  if (entry.structuralOverlap)
    limitations.push(
      "This stream's chain reaches sectors the FAT, the DIFAT or the directory already owns, so its byte range is not resolved in this step.",
    );
  // A zero-byte stream is a file: it has content (none) and opens as empty,
  // rather than being reported as metadata that carries no bytes.
  // A version-4 size beyond 2^53-1 cannot be carried, so its declaration is
  // unknown: the clamped `streamSize` is not published as an observed size and
  // the entry has no byte range to open.
  const sizeKnown = entry.streamSizeRepresentable;
  const resolvable =
    sizeKnown &&
    entry.storage === "fat" &&
    entry.byteOffset !== null &&
    !entry.structuralOverlap;
  const emptyStream =
    sizeKnown && entry.storage === "empty" && entry.streamSize === 0;
  if (!sizeKnown)
    limitations.push(
      "This stream declares more bytes than a JavaScript number carries exactly, so its declared size is unknown here rather than the clamped value that bounds the parse.",
    );
  return {
    path: path ?? "",
    kind: resolvable || emptyStream ? "file" : "metadata",
    declaredSize: sizeKnown ? entry.streamSize : null,
    compressedSize: null,
    executable: false,
    encrypted: false,
    byteOffset: resolvable && entry.streamSize > 0 ? entry.byteOffset : null,
    declaredIntegrity: null,
    unpacked: false,
    limitations,
    adapterKey: `compound-file/${String(entry.index)}`,
  };
};
