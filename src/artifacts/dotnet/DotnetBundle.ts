import type { FileHandle } from "node:fs/promises";
import { BinaryReader } from "../../domain/binaryContainer.js";
import {
  DEFAULT_DOTNET_BUNDLE_READER_LIMITS,
  type DotnetBundleReaderLimits,
} from "../../domain/artifactReaderLimits.js";

import {
  readArtifactFileChunks,
  ArtifactPathRegistry,
  normalizeArtifactPath,
  ArtifactReaderFailure,
  malformedArtifact,
  truncatedArtifact,
  artifactFixedLimitFailure,
  artifactReaderLimitFailure,
  abortIfNeeded,
} from "../../resources/index.js";
import { decodeStrictUtf8 } from "../../domain/strictUtf8.js";

/** SHA-256 marker embedded by Microsoft's apphost; the preceding UInt64 is the header offset. */
export const DOTNET_BUNDLE_SIGNATURE = Buffer.from(
  "8b1202b96a612038727b930214d7a03213f5b9e6efae3318ee3b2dce24b36aae",
  "hex",
);

export interface DotnetBundleFile {
  readonly path: string;
  readonly offset: number;
  readonly size: number;
  readonly compressedSize: number;
  readonly storedSize: number;
  readonly fileType: number;
}

export interface DotnetBundle {
  readonly majorVersion: number;
  readonly minorVersion: number;
  readonly headerOffset: number;
  readonly files: readonly DotnetBundleFile[];
}

/** Scan [0, markerSearchEnd) for the first marker; header offsets use whole-file coordinates. */
export const findDotnetBundleHeader = async (
  handle: FileHandle,
  size: number,
  signal?: AbortSignal,
  markerSearchEnd = size,
): Promise<number | undefined> => {
  abortIfNeeded(signal);
  if (markerSearchEnd === 0) return undefined;
  // A 32-byte signature preceded by an 8-byte offset spans 40 bytes, so a
  // boundary-straddling match needs at most 39 tail bytes + 39 head bytes.
  const SEAM_CARRY = 39;
  const seam = Buffer.allocUnsafe(SEAM_CARRY * 2);
  const seamReader = new BinaryReader(seam, true, "dotnet-bundle");
  let tailLen = 0;
  const checkMatches = (
    bytes: Buffer,
    reader: BinaryReader | undefined,
  ): number | null | undefined => {
    for (
      let index = bytes.indexOf(DOTNET_BUNDLE_SIGNATURE);
      index >= 0;
      index = bytes.indexOf(DOTNET_BUNDLE_SIGNATURE, index + 1)
    ) {
      if (index < 8) continue;
      const offset = (
        reader ?? new BinaryReader(bytes, true, "dotnet-bundle")
      ).word(index - 8, 64);
      // HostWriter.IsBundle uses the first apphost marker. Later markers may
      // belong to embedded native apphosts, whose coordinates are not this host's.
      // An offset outside the host file cannot name a bundle header here, so treat
      // the carrier as not holding a .NET bundle rather than aborting outer native
      // classification.
      if (offset === 0n || size < 12 || offset > BigInt(size - 12)) return null;
      return Number(offset);
    }
    return undefined;
  };
  for await (const value of readArtifactFileChunks(handle, {
    end: markerSearchEnd - 1,
    signal,
  })) {
    abortIfNeeded(signal);
    const chunk: Buffer = value;
    if (chunk.length === 0) continue;
    if (tailLen > 0) {
      const headLen = Math.min(SEAM_CARRY, chunk.length);
      chunk.copy(seam, tailLen, 0, headLen);
      const seamResult = checkMatches(
        seam.subarray(0, tailLen + headLen),
        seamReader,
      );
      if (seamResult !== undefined)
        return seamResult === null ? undefined : seamResult;
    }
    const chunkResult = checkMatches(chunk, undefined);
    if (chunkResult !== undefined)
      return chunkResult === null ? undefined : chunkResult;
    // A complete marker already examined must not be examined again.
    if (chunk.length >= SEAM_CARRY) {
      chunk.copy(seam, 0, chunk.length - SEAM_CARRY, chunk.length);
      tailLen = SEAM_CARRY;
    } else {
      const total = tailLen + chunk.length;
      if (total <= SEAM_CARRY) {
        chunk.copy(seam, tailLen);
        tailLen = total;
      } else {
        const drop = total - SEAM_CARRY;
        seam.copyWithin(0, drop, tailLen);
        chunk.copy(seam, tailLen - drop);
        tailLen = SEAM_CARRY;
      }
    }
  }
  return undefined;
};

/** Read Microsoft's v1/v2/v6 manifest without loading an assembly or executing the host. */
export const readDotnetBundle = async (
  handle: FileHandle,
  size: number,
  headerOffset: number,
  signal?: AbortSignal,
  limits: DotnetBundleReaderLimits = DEFAULT_DOTNET_BUNDLE_READER_LIMITS,
): Promise<DotnetBundle> => {
  const cursor = new BundleCursor(handle, size, headerOffset, limits, signal);
  const majorVersion = await cursor.u32();
  const minorVersion = await cursor.u32();
  if (![1, 2, 6].includes(majorVersion) || minorVersion !== 0)
    throw new ArtifactReaderFailure(
      "unavailable",
      `Unsupported .NET bundle header ${majorVersion}.${minorVersion}; supported versions are 1.0, 2.0 and 6.0`,
    );
  const count = await cursor.i32();
  if (count < 0) fail(".NET bundle entry count is negative");
  // Include the bundle ID length prefix and, starting at v2, the two
  // configuration ranges and flags. Each row has a type and a path prefix.
  const minimumEntry = majorVersion === 6 ? 26 : 18;
  const afterBundleId = (majorVersion >= 2 ? 40 : 0) + count * minimumEntry;
  if (1 + afterBundleId > cursor.remainingBytes)
    fail(".NET bundle entry count cannot fit in the manifest");
  if (count > limits.entry_count)
    throw artifactReaderLimitFailure(
      "artifact_limits.dotnet_bundle.entry_count",
      limits.entry_count,
      "count",
      count,
    );
  await cursor.string(afterBundleId);
  const manifestStart = BigInt(headerOffset);
  const configuration: { offset: number; size: number; type: number }[] = [];
  if (majorVersion >= 2) {
    for (const type of [3, 4]) {
      const offset = await cursor.nonnegativeI64();
      const size = await cursor.nonnegativeI64();
      if (!fitsBeforeManifest(offset, size, manifestStart))
        fail(
          ".NET bundle configuration location disagrees with its file table",
        );
      configuration.push({ offset: Number(offset), size: Number(size), type });
    }
    const flags = await cursor.u64();
    if (flags > 1n)
      throw new ArtifactReaderFailure(
        "unavailable",
        `Unsupported .NET bundle flags: ${flags}`,
      );
  }
  const files: DotnetBundleFile[] = [];
  const paths = new ArtifactPathRegistry({
    group: "dotnet_bundle",
    maxParts: limits.path_parts,
    maxNodes: limits.path_nodes,
  });
  let expandedBytes = 0n;
  for (let index = 0; index < count; index++) {
    abortIfNeeded(signal);
    const declaredOffset = await cursor.nonnegativeI64();
    const declaredSize = await cursor.nonnegativeI64();
    const declaredCompressedSize =
      majorVersion === 6 ? await cursor.nonnegativeI64() : 0n;
    const declaredStoredSize = declaredCompressedSize || declaredSize;
    if (!fitsBeforeManifest(declaredOffset, declaredStoredSize, manifestStart))
      fail(
        `.NET bundle entry crosses the manifest or file boundary (entry ${index + 1}, offset ${declaredOffset}, stored size ${declaredStoredSize})`,
      );
    const fileType = await cursor.u8();
    const path = await cursor.string((count - index - 1) * minimumEntry);
    const offset = Number(declaredOffset);
    const storedSize = Number(declaredStoredSize);
    const compressedSize = Number(declaredCompressedSize);
    const fileSize = exactManifestInteger(declaredSize);
    const normalized = normalizeArtifactPath(path);
    paths.add(normalized, "file");
    if (fileSize > limits.member_bytes || compressedSize > limits.member_bytes)
      throw artifactReaderLimitFailure(
        "artifact_limits.dotnet_bundle.member_bytes",
        limits.member_bytes,
        "bytes",
        Math.max(fileSize, compressedSize),
      );
    expandedBytes += BigInt(fileSize);
    if (expandedBytes > BigInt(limits.expanded_bytes))
      throw artifactReaderLimitFailure(
        "artifact_limits.dotnet_bundle.expanded_bytes",
        limits.expanded_bytes,
        "bytes",
        expandedBytes,
      );
    files.push({
      path,
      offset,
      size: fileSize,
      compressedSize,
      storedSize,
      fileType,
    });
  }
  const ranges = files
    .filter((file) => file.storedSize > 0)
    .toSorted((a, b) => a.offset - b.offset);
  let end = 0;
  for (const file of ranges) {
    if (file.offset < end)
      fail(`Overlapping .NET bundle entries: ${file.path}`);
    end = file.offset + file.storedSize;
  }
  for (const item of configuration) {
    if (item.offset === 0 && item.size === 0) continue;
    if (
      !files.some(
        (file) =>
          file.fileType === item.type &&
          file.offset === item.offset &&
          file.size === item.size &&
          file.compressedSize === 0,
      )
    )
      fail(".NET bundle configuration location disagrees with its file table");
  }
  return { majorVersion, minorVersion, headerOffset, files };
};

/** Cached positional reads bound allocation and correctly handle short reads. */
class BundleCursor {
  #position: number;
  #cache = new BinaryReader(Buffer.alloc(0), true, "dotnet-bundle");
  #cacheOffset = 0;

  constructor(
    private readonly handle: FileHandle,
    private readonly size: number,
    private readonly start: number,
    private readonly limits: DotnetBundleReaderLimits,
    private readonly signal?: AbortSignal,
  ) {
    this.#position = start;
  }

  get remainingBytes(): number {
    return this.size - this.#position;
  }

  #requireRemaining(length: number): number {
    const remaining = this.remainingBytes;
    if (length > remaining)
      throw truncatedArtifact(
        "dotnet-bundle",
        "Truncated .NET bundle manifest",
        {
          offset: this.#position,
          availableBytes: remaining,
          requiredBytes: length,
        },
      );
    return remaining;
  }

  async #advance(length: number): Promise<number> {
    abortIfNeeded(this.signal);
    const remaining = this.#requireRemaining(length);
    const consumed = this.#position - this.start;
    if (consumed + length > this.limits.metadata_bytes)
      throw artifactReaderLimitFailure(
        "artifact_limits.dotnet_bundle.metadata_bytes",
        this.limits.metadata_bytes,
        "bytes",
        consumed + length,
      );
    const cached = this.#position - this.#cacheOffset;
    if (cached < 0 || cached + length > this.#cache.bytes.length) {
      const cacheOffset = this.#position;
      const bytes = Buffer.alloc(
        Math.min(
          Math.max(length, 64 * 1024),
          remaining,
          this.limits.metadata_bytes - consumed,
        ),
      );
      let read = 0;
      while (read < bytes.length) {
        abortIfNeeded(this.signal);
        const reply = await this.handle.read(
          bytes,
          read,
          bytes.length - read,
          cacheOffset + read,
        );
        abortIfNeeded(this.signal);
        // The read stays inside the measured remainder, so a short read
        // means the file changed underneath it.
        if (reply.bytesRead === 0)
          throw new ArtifactReaderFailure(
            "integrity",
            ".NET bundle manifest ended before the measured file size",
            { integrityCheck: "read-coverage" },
          );
        read += reply.bytesRead;
      }
      this.#cache = new BinaryReader(bytes, true, "dotnet-bundle");
      this.#cacheOffset = cacheOffset;
    }
    const at = this.#position - this.#cacheOffset;
    this.#position += length;
    return at;
  }

  async u8(): Promise<number> {
    const at = await this.#advance(1);
    return this.#cache.u8(at);
  }

  async u32(): Promise<number> {
    const at = await this.#advance(4);
    return this.#cache.u32(at);
  }

  async i32(): Promise<number> {
    const at = await this.#advance(4);
    return this.#cache.i32(at);
  }

  async nonnegativeI64(): Promise<bigint> {
    const at = await this.#advance(8);
    const value = this.#cache.i64(at);
    if (value < 0n) fail(".NET bundle offset or size is negative");
    return value;
  }

  async u64(): Promise<bigint> {
    const at = await this.#advance(8);
    return this.#cache.word(at, 64);
  }

  async string(minimumTailBytes: number): Promise<string> {
    let length = 0;
    for (let shift = 0; shift <= 28; shift += 7) {
      const byte = await this.u8();
      // BinaryReader.ReadString uses a nonnegative signed Int32 length.
      if (shift === 28 && byte > 7) fail("Invalid .NET bundle string length");
      length += (byte & 127) * 2 ** shift;
      if ((byte & 128) !== 0) continue;
      this.#requireRemaining(length + minimumTailBytes);
      if (length > this.limits.string_bytes)
        throw artifactReaderLimitFailure(
          "artifact_limits.dotnet_bundle.string_bytes",
          this.limits.string_bytes,
          "bytes",
          length,
        );
      // Source failures are not encoding failures. Acquire bytes outside the
      // decoder boundary so I/O and cancellation retain their original cause.
      const at = await this.#advance(length);
      const bytes = this.#cache.range(at, length, "manifest string");
      try {
        return decodeStrictUtf8(bytes, "preserve");
      } catch (cause) {
        throw malformedArtifact(
          "dotnet-bundle",
          "Invalid UTF-8 in .NET bundle manifest",
          { cause, offset: this.#cacheOffset + at, field: "manifest-string" },
        );
      }
    }
    return fail("Invalid .NET bundle string length");
  }
}

const fitsBeforeManifest = (
  offset: bigint,
  size: bigint,
  manifestStart: bigint,
): boolean => offset <= manifestStart && size <= manifestStart - offset;

const exactManifestInteger = (value: bigint): number => {
  if (value > BigInt(Number.MAX_SAFE_INTEGER))
    throw artifactFixedLimitFailure(
      {
        name: "The .NET bundle exact integer range",
        kind: "parser",
        limit: Number.MAX_SAFE_INTEGER,
        unit: "integer units",
      },
      `A .NET bundle offset or size of ${String(value)} is above the exact integer range of ${String(Number.MAX_SAFE_INTEGER)}.`,
    );
  return Number(value);
};

const fail = (message: string): never => {
  throw malformedArtifact("dotnet-bundle", message);
};
