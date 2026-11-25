import { ArtifactPreparation } from "./ArtifactPreparation.js";
import type { FileHandle } from "node:fs/promises";
import { Transform, type Readable } from "node:stream";
import { setImmediate } from "node:timers/promises";

import { readArtifactFileBytes } from "./ArtifactFileRange.js";
import {
  ArtifactReaderFailure,
  ArtifactResourceScope,
  ArtifactFileSource,
  artifactFixedLimitFailure,
  artifactParseFailure,
  artifactReaderLimitFailure,
  assertArtifactReadActive,
  assertProducedEntry,
  copyArtifactEntry,
  yieldArtifactRead,
  type ArtifactEntry,
  type ArtifactReader,
  type ArtifactReaderTraversal,
  type ArtifactTraversalOptions,
} from "../resources/index.js";
import {
  ArtifactStreamLifecycle,
  ownArtifactStream,
} from "./OwnedArtifactStream.js";
import { cancellableArtifactChunks } from "./OwnedAsyncArtifactStreams.js";
import type { StableRegularFileDescriptor } from "../filesystem/RegularFile.js";
import type { AndroidSparseImageMetadata } from "../domain/formatMetadata/androidAndSystemMetadata.js";
import { artifactExpansionBudgetBytes } from "../domain/artifactExpansionBudget.js";
import {
  DEFAULT_ANDROID_SPARSE_IMAGE_READER_LIMITS,
  type AndroidSparseImageReaderLimits,
} from "../domain/artifactReaderLimits.js";
import {
  ANDROID_SPARSE_FILE_HEADER_BYTES,
  ANDROID_SPARSE_FIXED_LIMITS,
  ANDROID_SPARSE_IMAGE_LIMITATIONS,
  AndroidSparseImageAccumulator,
  androidSparseDeclaredExpandedBytes,
  parseAndroidSparseChunk,
  parseAndroidSparseFileHeader,
  type AndroidSparseImage,
  type AndroidSparseImageParseError,
  type AndroidSparseRun,
} from "../domain/firmware/androidSparseImage.js";

const LABEL = "Android sparse image";

/** Verify the member's byte count and source before stream completion. */
const checkedArtifactMemberStream = (
  entry: ArtifactEntry,
  label: string,
  incomplete: (detail: string) => Error,
  verify: () => Promise<void>,
): Transform => {
  let bytes = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      callback(null, chunk);
    },
    flush(callback) {
      if (bytes !== entry.declaredSize) {
        callback(incomplete(`member ended early: ${entry.path}`));
        return;
      }
      void verify().then(
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
};
/** The expanded partition's one child path. */
export const ANDROID_SPARSE_IMAGE_CHILD_PATH = "image.raw";
/** Chunk headers and small RAW payloads are read through one bounded window. */
const READ_WINDOW_BYTES = 64 * 1024;
/**
 * RAW payloads up to this size go through the window. Larger ones are skipped
 * by the chunk walk and streamed directly during expansion.
 */
const SMALL_PAYLOAD_BYTES = 16 * 1024;
/** Expanded output is coalesced into buffers of this size. */
const OUTPUT_BATCH_BYTES = 64 * 1024;
/** Batched output yields to the event loop at least this often. */
const OUTPUT_YIELD_BYTES = 1024 * 1024;
/** One descriptor read of a large RAW run. */
const RAW_READ_BYTES = 64 * 1024;

interface PreparedSparseImage {
  readonly image: AndroidSparseImage;
  readonly entry: ArtifactEntry;
  readonly coverage: ArtifactReaderTraversal;
}

/**
 * Inventory an Android sparse image and expand it into one raw partition
 * image. RAW chunks copy stored bytes, FILL repeats its 4-byte pattern and
 * DONT_CARE produces zeros. Checksums are recorded, not verified.
 */
export class AndroidSparseImageArtifactReader implements ArtifactReader {
  readonly format = "android-sparse-image" as const;
  readonly #scope = new ArtifactResourceScope();
  readonly #lifecycle = new ArtifactStreamLifecycle(LABEL);
  readonly #source: ArtifactFileSource;
  readonly #preparation = new ArtifactPreparation();
  readonly #limits: AndroidSparseImageReaderLimits;
  readonly #expandedBytes: number | undefined;
  #prepared: PreparedSparseImage | undefined;

  constructor(
    path: string,
    admitted?: StableRegularFileDescriptor,
    limits: AndroidSparseImageReaderLimits = DEFAULT_ANDROID_SPARSE_IMAGE_READER_LIMITS,
    expandedBytes?: number,
  ) {
    this.#source = new ArtifactFileSource(path, LABEL, admitted);
    this.#limits = limits;
    this.#expandedBytes = expandedBytes;
  }

  formatMetadata(): AndroidSparseImageMetadata | undefined {
    const image = this.#prepared?.image;
    return image === undefined ? undefined : toMetadata(image);
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
      if (this.#prepared !== undefined) await this.#source.read(signal);
      await this.#preparation.run(
        signal,
        () => this.#prepare(signal),
        () => this.#assertOpen(signal),
      );
    });
    this.#assertOpen(signal);
    const prepared = this.#prepared;
    if (prepared === undefined)
      throw new ArtifactReaderFailure(
        "unavailable",
        `${LABEL} reader has no prepared inventory`,
      );
    options?.onCoverage?.({
      ...prepared.coverage,
      limitations: [...prepared.coverage.limitations],
    });
    yield copyArtifactEntry(prepared.entry);
    this.#assertOpen(signal);
  }

  async open(entry: ArtifactEntry, signal?: AbortSignal): Promise<Readable> {
    return this.#scope.run(async () => {
      this.#assertOpen(signal);
      const prepared = this.#prepared;
      const stored =
        prepared?.entry.adapterKey === entry.adapterKey
          ? prepared.entry
          : undefined;
      assertProducedEntry(
        entry,
        stored,
        `${LABEL} entry does not match its owning inventory`,
      );
      if (prepared === undefined)
        throw new ArtifactReaderFailure(
          "unavailable",
          `${LABEL} reader has no prepared inventory`,
        );
      const { handle, initial } = await this.#source.read(signal);
      this.#assertOpen(signal);
      const lifecycle = this.#lifecycle.member(signal);
      // The expansion retires itself on cancellation even while backpressured.
      const source = cancellableArtifactChunks(
        expandRuns(
          handle,
          initial.size,
          prepared.image.runs,
          lifecycle.signal,
          lifecycle.cancellationFailure,
        ),
        {
          signal: lifecycle.signal,
          cancellationFailure: lifecycle.cancellationFailure,
        },
      );
      const output = checkedArtifactMemberStream(
        stored,
        LABEL,
        (detail) =>
          new ArtifactReaderFailure("integrity", `${LABEL} ${detail}`, {
            integrityCheck: "declared-size",
          }),
        () =>
          lifecycle.verify((verifySignal) => this.#source.read(verifySignal)),
      );
      ownArtifactStream(source, output, {
        scope: this.#scope,
        signal: lifecycle.signal,
        cancellationFailure: lifecycle.cancellationFailure,
        label: LABEL,
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

  #assertOpen(signal?: AbortSignal): void {
    assertArtifactReadActive(signal);
    if (this.#lifecycle.closed)
      throw new ArtifactReaderFailure("unavailable", `${LABEL} reader closed`);
  }

  async #prepare(signal?: AbortSignal): Promise<void> {
    const { handle, initial } = await this.#source.read(signal);
    const fileSize = initial.size;
    // Read the fixed header, then only the extension it declares.
    const fixed = await readArtifactFileBytes(
      "android-sparse-image",
      handle,
      0,
      Math.min(fileSize, ANDROID_SPARSE_FILE_HEADER_BYTES),
      fileSize,
      signal,
    );
    this.#assertOpen(signal);
    const parsed = parseAndroidSparseFileHeader(fixed, fileSize);
    if (!parsed.ok) throw parseFailure(parsed.error);
    const header = parsed.value;
    const undecoded = await readArtifactFileBytes(
      "android-sparse-image",
      handle,
      ANDROID_SPARSE_FILE_HEADER_BYTES,
      header.fileHeaderSize - ANDROID_SPARSE_FILE_HEADER_BYTES,
      fileSize,
      signal,
    );
    this.#assertOpen(signal);
    const chunkCount = this.#limits.chunk_count;
    if (header.totalChunks > chunkCount)
      throw artifactReaderLimitFailure(
        "artifact_limits.android_sparse_image.chunk_count",
        chunkCount,
        "count",
        header.totalChunks,
        "capacity",
      );
    const declared = androidSparseDeclaredExpandedBytes(header);
    if (!declared.ok) throw parseFailure(declared.error);
    // Admit the expansion the header declares before walking any chunk.
    const budget =
      this.#expandedBytes ?? artifactExpansionBudgetBytes(fileSize);
    if (declared.value > budget)
      throw artifactReaderLimitFailure(
        "artifact_limits.expanded_bytes",
        budget,
        "bytes",
        declared.value,
        "capacity",
      );
    // The window starts after the header, so no header byte is read twice.
    const window = new FileWindow(
      handle,
      fileSize,
      signal,
      header.fileHeaderSize,
    );
    const accumulator = new AndroidSparseImageAccumulator(header, undecoded);
    for (let index = 0; index < header.totalChunks; index += 1) {
      if (index % 256 === 255) await yieldArtifactRead(signal);
      this.#assertOpen(signal);
      const offset = accumulator.nextOffset;
      const bytes = await window.read(offset, header.chunkHeaderSize + 4);
      const chunk = parseAndroidSparseChunk(
        header,
        bytes,
        offset,
        fileSize,
        index,
      );
      if (!chunk.ok) throw parseFailure(chunk.error);
      accumulator.add(chunk.value);
    }
    const image = accumulator.finish(fileSize);
    if (!image.ok) throw parseFailure(image.error);
    await this.#source.read(signal);
    this.#assertOpen(signal);
    this.#prepared = {
      image: image.value,
      entry: entryFor(image.value),
      coverage: { status: "complete", limitations: image.value.limitations },
    };
  }
}

/**
 * Serve small positional reads from one bounded window. A miss refills a whole
 * window unless the caller skipped a large payload since its last read; the
 * bytes after such a skip are usually more payload, so only the request is read.
 */
class FileWindow {
  #start = 0;
  #bytes: Buffer = Buffer.alloc(0);
  #requestEnd: number;

  constructor(
    private readonly handle: Pick<FileHandle, "read">,
    private readonly fileSize: number,
    private readonly signal: AbortSignal | undefined,
    /** Bytes before this offset were already consumed by the caller. */
    consumed = 0,
  ) {
    this.#requestEnd = consumed;
  }

  /** Up to `length` bytes at `offset`, fewer at the end of the file. */
  async read(offset: number, length: number): Promise<Buffer> {
    const end = Math.min(this.fileSize, offset + length);
    if (offset >= end) return Buffer.alloc(0);
    if (offset < this.#start || end > this.#start + this.#bytes.length) {
      const skippedPayload = offset - this.#requestEnd >= SMALL_PAYLOAD_BYTES;
      const readLength = skippedPayload
        ? length
        : Math.max(READ_WINDOW_BYTES, length);
      this.#start = offset;
      this.#bytes = await readArtifactFileBytes(
        "android-sparse-image",
        this.handle,
        offset,
        Math.min(this.fileSize - offset, readLength),
        this.fileSize,
        this.signal,
      );
    }
    this.#requestEnd = end;
    return this.#bytes.subarray(offset - this.#start, end - this.#start);
  }
}

/** Coalesce small expanded pieces into bounded output buffers. */
class OutputBatch {
  #bytes = Buffer.allocUnsafe(OUTPUT_BATCH_BYTES);
  #length = 0;

  /** Copy `bytes` in, yielding each batch it fills. */
  *copy(bytes: Uint8Array): Generator<Buffer> {
    yield* this.#write(bytes.length, (target, start, consumed, length) => {
      target.set(bytes.subarray(consumed, consumed + length), start);
    });
  }

  /**
   * Repeat `value` for `length` bytes, yielding each batch it fills. Batch and
   * run lengths are multiples of 4, so a pattern never splits out of phase.
   */
  *fill(value: Uint8Array | number, length: number): Generator<Buffer> {
    yield* this.#write(length, (target, start, _consumed, part) => {
      target.fill(value, start, start + part);
    });
  }

  /** The pending partial batch, if any. */
  take(): Buffer | undefined {
    if (this.#length === 0) return undefined;
    const pending = this.#bytes.subarray(0, this.#length);
    this.#bytes = Buffer.allocUnsafe(OUTPUT_BATCH_BYTES);
    this.#length = 0;
    return pending;
  }

  *#write(
    length: number,
    write: (
      target: Buffer,
      start: number,
      consumed: number,
      part: number,
    ) => void,
  ): Generator<Buffer> {
    for (let consumed = 0; consumed < length;) {
      const part = Math.min(
        length - consumed,
        this.#bytes.length - this.#length,
      );
      write(this.#bytes, this.#length, consumed, part);
      this.#length += part;
      consumed += part;
      if (this.#length === this.#bytes.length) {
        const full = this.#bytes;
        this.#bytes = Buffer.allocUnsafe(OUTPUT_BATCH_BYTES);
        this.#length = 0;
        yield full;
      }
    }
  }
}

async function* expandRuns(
  handle: Pick<FileHandle, "read">,
  fileSize: number,
  runs: readonly AndroidSparseRun[],
  signal: AbortSignal,
  cancellationFailure: (reason: unknown) => ArtifactReaderFailure,
): AsyncGenerator<Buffer> {
  const assertActive = (): void => {
    if (signal.aborted) throw cancellationFailure(signal.reason);
  };
  // Cancellation is reported here with the lifecycle's failure, not the window's.
  const window = new FileWindow(handle, fileSize, undefined);
  const batch = new OutputBatch();
  let bytesSinceYield = 0;
  for (const run of runs) {
    assertActive();
    if (run.kind === "raw" && run.length > SMALL_PAYLOAD_BYTES) {
      const pending = batch.take();
      if (pending !== undefined) yield pending;
      // Read in this iterator, not a nested prefetching stream, so each
      // descriptor read stays pending in the owner that cancellation waits on.
      const end = run.offset + run.length;
      for (let position = run.offset; position < end;) {
        assertActive();
        const chunk = Buffer.allocUnsafe(
          Math.min(RAW_READ_BYTES, end - position),
        );
        const { bytesRead } = await handle.read(
          chunk,
          0,
          chunk.length,
          position,
        );
        assertActive();
        if (bytesRead === 0) break;
        position += bytesRead;
        yield chunk.subarray(0, bytesRead);
      }
      continue;
    }
    let filled: Generator<Buffer>;
    if (run.kind === "raw") {
      const bytes = await window.read(run.offset, run.length);
      assertActive();
      filled = batch.copy(bytes);
    } else
      filled = batch.fill(run.kind === "fill" ? run.pattern : 0, run.length);
    for (const output of filled) {
      yield output;
      bytesSinceYield += output.length;
      if (bytesSinceYield >= OUTPUT_YIELD_BYTES) {
        await setImmediate();
        bytesSinceYield -= OUTPUT_YIELD_BYTES;
      }
      assertActive();
    }
  }
  const pending = batch.take();
  if (pending !== undefined) yield pending;
}

const parseFailure = (failure: AndroidSparseImageParseError): unknown => {
  const facts = failure.failure;
  if (facts.kind === "limit") {
    const ceiling = ANDROID_SPARSE_FIXED_LIMITS.get(facts.limit.name);
    if (ceiling !== undefined)
      return artifactFixedLimitFailure(
        {
          name: ceiling.name,
          kind: "parser",
          limit: facts.limit.maximum,
          unit: ceiling.unit,
        },
        failure.message,
        "capacity",
        { cause: failure },
      );
  }
  return artifactParseFailure(failure, undefined, () => "capacity");
};

const entryFor = (image: AndroidSparseImage): ArtifactEntry => ({
  path: ANDROID_SPARSE_IMAGE_CHILD_PATH,
  kind: "file",
  declaredSize: image.expandedBytes,
  compressedSize: null,
  executable: false,
  encrypted: false,
  byteOffset: null,
  declaredIntegrity: null,
  unpacked: false,
  limitations:
    image.counts.dontCare > 0
      ? [ANDROID_SPARSE_IMAGE_LIMITATIONS.dontCare]
      : [],
  adapterKey: `android-sparse-image:${ANDROID_SPARSE_IMAGE_CHILD_PATH}`,
  sourcePath: ANDROID_SPARSE_IMAGE_CHILD_PATH,
});

const toMetadata = (image: AndroidSparseImage): AndroidSparseImageMetadata => ({
  kind: "android-sparse-image",
  magic: "0xed26ff3a",
  major_version: image.header.majorVersion,
  minor_version: image.header.minorVersion,
  file_header_size: image.header.fileHeaderSize,
  chunk_header_size: image.header.chunkHeaderSize,
  block_size: image.header.blockSize,
  total_blocks: image.header.totalBlocks,
  total_chunks: image.header.totalChunks,
  expanded_size: image.expandedBytes,
  image_checksum: image.header.imageChecksum,
  checksums_verified: false,
  chunk_counts: {
    raw: image.counts.raw,
    fill: image.counts.fill,
    dont_care: image.counts.dontCare,
    crc32: image.counts.crc32,
  },
  covered_bytes: {
    raw: image.coveredBytes.raw,
    fill: image.coveredBytes.fill,
    dont_care: image.coveredBytes.dontCare,
  },
  fill_patterns: [...image.fillPatterns],
  crc32_chunks: image.crc32Chunks.map((chunk) => ({
    file_offset: chunk.fileOffset,
    value: chunk.value,
  })),
  undecoded_file_header_bytes: image.undecodedFileHeaderBytes,
  undecoded_file_header_hex: image.undecodedFileHeaderHex,
  undecoded_chunk_header_bytes: image.chunkHeaderExtraBytes,
  trailing_bytes: image.trailingBytes,
});
