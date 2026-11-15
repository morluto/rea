import type { FileHandle } from "node:fs/promises";
import {
  DEFAULT_DOTNET_BUNDLE_READER_LIMITS,
  type DotnetBundleReaderLimits,
} from "../../domain/artifactReaderLimits.js";
import { artifactReaderLimitFailure } from "../ArtifactReaderLimits.js";

import { readArtifactFileChunks } from "../readArtifactFileChunks.js";
import {
  ArtifactPathRegistry,
  normalizeArtifactPath,
} from "../ArtifactPaths.js";
import { abortIfNeeded } from "../ArtifactHash.js";
import {
  ArtifactReaderFailure,
  artifactFixedLimitFailure,
} from "../ArtifactReader.js";

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
  let tail = Buffer.alloc(0);
  if (markerSearchEnd === 0) return undefined;
  for await (const value of readArtifactFileChunks(handle, {
    end: markerSearchEnd - 1,
    signal,
  })) {
    abortIfNeeded(signal);
    const chunk: Buffer = value;
    const bytes = Buffer.concat([tail, chunk]);
    for (
      let index = bytes.indexOf(DOTNET_BUNDLE_SIGNATURE);
      index >= 0;
      index = bytes.indexOf(DOTNET_BUNDLE_SIGNATURE, index + 1)
    ) {
      if (index < 8) continue;
      const offset = bytes.readBigUInt64LE(index - 8);
      // HostWriter.IsBundle uses the first apphost marker. Later markers may
      // belong to embedded native apphosts, whose coordinates are not this host's.
      if (offset === 0n) return undefined;
      if (offset > BigInt(size - 12))
        fail(".NET bundle header is outside the host file");
      return Number(offset);
    }
    // A complete marker already examined must not be examined again.
    tail = bytes.subarray(Math.max(0, bytes.length - 39));
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
  if (count > limits.entry_count)
    throw artifactReaderLimitFailure(
      "artifact_limits.dotnet_bundle.entry_count",
      limits.entry_count,
      "count",
      count,
    );
  await cursor.string(); // Bundle ID is not an authentication or content digest.
  const configuration: { offset: number; size: number; type: number }[] = [];
  if (majorVersion >= 2) {
    configuration.push({
      offset: await cursor.nonnegativeI64(),
      size: await cursor.nonnegativeI64(),
      type: 3,
    });
    configuration.push({
      offset: await cursor.nonnegativeI64(),
      size: await cursor.nonnegativeI64(),
      type: 4,
    });
    const flags = await cursor.u64();
    if (flags > 1)
      throw new ArtifactReaderFailure(
        "unavailable",
        `Unsupported .NET bundle flags: ${flags}`,
      );
  }
  const files: DotnetBundleFile[] = [];
  const paths = new ArtifactPathRegistry({
    maxParts: limits.path_parts,
    maxNodes: limits.path_nodes,
    limitFailure: (field, maximum, required) =>
      artifactReaderLimitFailure(
        `artifact_limits.dotnet_bundle.${field}`,
        maximum,
        "count",
        required,
      ),
  });
  let expandedBytes = 0n;
  for (let index = 0; index < count; index++) {
    abortIfNeeded(signal);
    const offset = await cursor.nonnegativeI64();
    const fileSize = await cursor.nonnegativeI64();
    const compressedSize =
      majorVersion === 6 ? await cursor.nonnegativeI64() : 0;
    const fileType = (await cursor.take(1))[0]!;
    const path = await cursor.string();
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
    const storedSize = compressedSize || fileSize;
    if (offset > headerOffset || storedSize > headerOffset - offset)
      fail(`.NET bundle entry crosses the manifest or file boundary: ${path}`);
    files.push({ path, offset, size: fileSize, compressedSize, fileType });
  }
  const ranges = files
    .filter((file) => (file.compressedSize || file.size) > 0)
    .toSorted((a, b) => a.offset - b.offset);
  let end = 0;
  for (const file of ranges) {
    if (file.offset < end)
      fail(`Overlapping .NET bundle entries: ${file.path}`);
    end = file.offset + (file.compressedSize || file.size);
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
  #cache = Buffer.alloc(0);
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

  async take(length: number): Promise<Buffer> {
    abortIfNeeded(this.signal);
    const consumed = this.#position - this.start;
    if (consumed + length > this.limits.metadata_bytes)
      throw artifactReaderLimitFailure(
        "artifact_limits.dotnet_bundle.metadata_bytes",
        this.limits.metadata_bytes,
        "bytes",
        consumed + length,
      );
    if (length > this.size - this.#position)
      fail("Truncated .NET bundle manifest");
    const cached = this.#position - this.#cacheOffset;
    if (cached < 0 || cached + length > this.#cache.length) {
      this.#cacheOffset = this.#position;
      this.#cache = Buffer.alloc(
        Math.min(
          Math.max(length, 64 * 1024),
          this.size - this.#position,
          this.limits.metadata_bytes - consumed,
        ),
      );
      let read = 0;
      while (read < this.#cache.length) {
        abortIfNeeded(this.signal);
        const reply = await this.handle.read(
          this.#cache,
          read,
          this.#cache.length - read,
          this.#cacheOffset + read,
        );
        abortIfNeeded(this.signal);
        if (reply.bytesRead === 0) fail("Truncated .NET bundle manifest");
        read += reply.bytesRead;
      }
    }
    const at = this.#position - this.#cacheOffset;
    this.#position += length;
    return this.#cache.subarray(at, at + length);
  }

  async u32(): Promise<number> {
    return (await this.take(4)).readUInt32LE();
  }
  async i32(): Promise<number> {
    return (await this.take(4)).readInt32LE();
  }
  async nonnegativeI64(): Promise<number> {
    const value = (await this.take(8)).readBigInt64LE();
    if (value < 0n) fail(".NET bundle offset or size is negative");
    return this.exactInteger(value);
  }
  private exactInteger(value: bigint): number {
    if (value > BigInt(Number.MAX_SAFE_INTEGER))
      throw artifactFixedLimitFailure(
        ".NET bundle exact integer range",
        Number.MAX_SAFE_INTEGER,
        "integer units",
      );
    return Number(value);
  }
  async u64(): Promise<number> {
    return this.exactInteger((await this.take(8)).readBigUInt64LE());
  }
  async string(): Promise<string> {
    let length = 0;
    for (let shift = 0; shift <= 28; shift += 7) {
      const byte = (await this.take(1))[0]!;
      if (shift === 28 && byte > 15) fail("Invalid .NET bundle string length");
      length += (byte & 127) * 2 ** shift;
      if ((byte & 128) !== 0) continue;
      if (length > this.limits.string_bytes)
        throw artifactReaderLimitFailure(
          "artifact_limits.dotnet_bundle.string_bytes",
          this.limits.string_bytes,
          "bytes",
          length,
        );
      // Source failures are not encoding failures. Acquire bytes outside the
      // decoder boundary so I/O and cancellation retain their original cause.
      const bytes = await this.take(length);
      try {
        return new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: true,
        }).decode(bytes);
      } catch (cause) {
        throw new ArtifactReaderFailure(
          "format",
          "Invalid UTF-8 in .NET bundle manifest",
          { cause },
        );
      }
    }
    return fail("Invalid .NET bundle string length");
  }
}

const fail = (message: string): never => {
  throw new ArtifactReaderFailure("format", message);
};
