import {
  ANDROID_SPARSE_CHUNK_COUNT_LIMIT,
  ANDROID_SPARSE_CHUNK_HEADER_SIZE,
  ANDROID_SPARSE_HEADER_SIZE,
  AndroidSparseWalkAccumulator,
  parseAndroidSparseChunkHeader,
  parseAndroidSparseHeader,
  readUint32LE,
} from "../domain/androidSparseImageFormat.js";
import {
  DEFAULT_ANDROID_SPARSE_READER_LIMITS,
  type AndroidSparseReaderLimits,
} from "../domain/artifactReaderLimits.js";
import type {
  AndroidSparseChunkMetadata,
  AndroidSparseImageMetadata,
} from "../domain/formatMetadata/androidAndSystemMetadata.js";
import { ParseFailureError } from "../domain/parseFailure.js";
import type { StableRegularFileDescriptor } from "../filesystem/RegularFile.js";
import {
  artifactParseFailure,
  artifactReaderLimitFailure,
} from "../resources/index.js";
import { readArtifactFileBytes } from "./ArtifactFileRange.js";
import {
  PositionalArtifactReader,
  type PositionalArtifactEntries,
  type PositionalArtifactEntry,
} from "./PositionalArtifactReader.js";

const HEADER_READ_WINDOW_BYTES = 4096;

type SparseChunkEntry = PositionalArtifactEntry & {
  readonly formatMetadata: AndroidSparseChunkMetadata;
};

/** Maps domain sparse parse failures into typed REA reader/limit failures. */
const toReaderFailure = (
  error: ParseFailureError,
  signal: AbortSignal | undefined,
): unknown => {
  const { failure } = error;
  if (
    failure.kind === "limit" &&
    failure.limit.name === ANDROID_SPARSE_CHUNK_COUNT_LIMIT.name
  ) {
    return artifactReaderLimitFailure(
      ANDROID_SPARSE_CHUNK_COUNT_LIMIT.parameter,
      failure.limit.maximum,
      ANDROID_SPARSE_CHUNK_COUNT_LIMIT.unit,
      failure.limit.required,
    );
  }
  return artifactParseFailure(error, signal, () => "capacity");
};

/**
 * Bounded, strictly read-only Android Sparse (`simg`, `0xed26ff3a`) container reader.
 * Validates header and every chunk descriptor using `O(1)` header read windows
 * without materializing virtual `FILL` or `DONT_CARE` blocks; exposes `RAW`
 * payload slices directly by carrier byte offset.
 */
export class AndroidSparseImageArtifactReader extends PositionalArtifactReader<
  AndroidSparseImageMetadata,
  SparseChunkEntry
> {
  override readonly format = "android-sparse-image" as const;

  constructor(
    path: string,
    admitted?: StableRegularFileDescriptor,
    private readonly limits: AndroidSparseReaderLimits = DEFAULT_ANDROID_SPARSE_READER_LIMITS,
  ) {
    super(path, "Android sparse image", admitted);
  }

  formatMetadata(): AndroidSparseImageMetadata | undefined {
    const metadata = this.preparedFormatMetadata;
    return metadata === undefined
      ? undefined
      : {
          ...metadata,
          crc32_chunk_values: [...metadata.crc32_chunk_values],
          chunks: metadata.chunks.map((chunk) => ({ ...chunk })),
        };
  }

  protected override async prepareEntries(
    signal?: AbortSignal,
  ): Promise<
    PositionalArtifactEntries<AndroidSparseImageMetadata, SparseChunkEntry>
  > {
    const { handle, initial } = await this.verifyCarrier(signal);
    const headerBytes = await readArtifactFileBytes(
      handle,
      0,
      Math.min(initial.size, ANDROID_SPARSE_HEADER_SIZE),
      initial.size,
      signal,
    );
    this.assertOpen(signal);

    try {
      const header = parseAndroidSparseHeader(
        headerBytes,
        initial.size,
        this.limits.chunk_count,
      );
      const accumulator = new AndroidSparseWalkAccumulator(
        header,
        initial.size,
      );

      let windowStart = -1;
      let windowBytes: Buffer<ArrayBufferLike> = Buffer.alloc(0);

      const readWindowSlice = async (
        offset: number,
        length: number,
      ): Promise<Uint8Array> => {
        if (offset >= initial.size) return Buffer.alloc(0);
        const windowEnd = windowStart + windowBytes.length;
        if (
          windowStart < 0 ||
          offset < windowStart ||
          offset + length > windowEnd
        ) {
          const readLength = Math.min(
            HEADER_READ_WINDOW_BYTES,
            initial.size - offset,
          );
          windowBytes = await readArtifactFileBytes(
            handle,
            offset,
            readLength,
            initial.size,
            signal,
          );
          this.assertOpen(signal);
          windowStart = offset;
        } else {
          this.assertOpen(signal);
        }
        const available = Math.min(
          length,
          windowStart + windowBytes.length - offset,
        );
        return windowBytes.subarray(
          offset - windowStart,
          offset - windowStart + available,
        );
      };

      for (let index = 0; index < header.totalChunks; index += 1) {
        const fileOffset = accumulator.currentOffset;
        const chunkHeaderSlice = await readWindowSlice(
          fileOffset,
          ANDROID_SPARSE_CHUNK_HEADER_SIZE,
        );
        const chunk = parseAndroidSparseChunkHeader(chunkHeaderSlice, header, {
          index,
          fileOffset,
          fileSize: initial.size,
          accumulatedBlocks: accumulator.accumulatedBlocks,
        });
        let wordValue: number | null = null;
        if (chunk.needsWordPayload) {
          const wordSlice = await readWindowSlice(chunk.dataOffset, 4);
          wordValue = readUint32LE(wordSlice, 0);
        }
        accumulator.recordChunk(chunk, wordValue);
      }

      const inspection = accumulator.finalize();
      const entries: SparseChunkEntry[] = inspection.rawEntries.map((plan) => ({
        path: plan.path,
        kind: "file",
        declaredSize: plan.declaredSize,
        compressedSize: null,
        executable: false,
        encrypted: false,
        byteOffset: plan.byteOffset,
        declaredIntegrity: null,
        unpacked: false,
        limitations: [],
        adapterKey: `android-sparse-image:${plan.path}`,
        formatMetadata: plan.metadata,
      }));

      return {
        entries,
        formatMetadata: inspection.metadata,
        coverage: {
          status: inspection.complete ? "complete" : "unknown",
          limitations: [...inspection.limitations],
        },
      };
    } catch (error) {
      if (error instanceof ParseFailureError) {
        throw toReaderFailure(error, signal);
      }
      throw error;
    }
  }
}
