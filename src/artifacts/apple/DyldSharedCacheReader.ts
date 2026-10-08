import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, type FileHandle } from "node:fs/promises";

import { applePlatform } from "../../domain/apple/applePlatforms.js";
import type { MachoImageFacts } from "../../domain/apple/dylibResolution.js";
import type {
  DyldCacheMapping,
  DyldCacheSubcache,
  DyldSharedCacheHeader,
} from "../../domain/apple/dyldSharedCache.js";
import { ArtifactReaderFailure } from "../ArtifactReader.js";
import { readMachoImage } from "./MachoLoadCommandReader.js";

const MAGIC_PREFIX = "dyld_v1";
const DEVELOPMENT_EXTENSION = ".development";
/** Header fields are valid only below `mappingOffset`; real headers are under 1 KiB. */
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_IMAGES = 200_000;
const MAX_MAPPINGS = 64;
const MAX_SUBCACHES = 256;
const MAX_PATH_BYTES = 4096;
const BLOCK_BYTES = 64 * 1024;
const HASH_CHUNK_BYTES = 1024 * 1024;

/** Byte offsets of `dyld_cache_header` fields in Apple's open-source dyld. */
const FIELD = {
  mappingOffset: 0x10,
  mappingCount: 0x14,
  imagesOffsetOld: 0x18,
  imagesCountOld: 0x1c,
  uuid: 0x58,
  cacheType: 0x68,
  platform: 0xd8,
  formatBits: 0xdc,
  sharedRegionStart: 0xe0,
  sharedRegionSize: 0xe8,
  maxSlide: 0xf0,
  osVersion: 0x16c,
  altPlatform: 0x170,
  altOsVersion: 0x174,
  subCacheArrayOffset: 0x188,
  subCacheArrayCount: 0x18c,
  symbolFileUuid: 0x190,
  imagesOffset: 0x1c0,
  imagesCount: 0x1c4,
  cacheSubType: 0x1c8,
} as const;

const hex = (value: bigint | number): string => `0x${value.toString(16)}`;

const uuidText = (bytes: Buffer): string => {
  const text = bytes.toString("hex").toUpperCase();
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
};

const safeNumber = (value: bigint, label: string): number => {
  if (value > BigInt(Number.MAX_SAFE_INTEGER))
    throw new ArtifactReaderFailure(
      "format",
      `dyld cache ${label} exceeds the safe range`,
    );
  return Number(value);
};

/** Block-cached positional reads over one cache file. */
class CacheFile {
  readonly #blocks = new Map<number, Buffer>();

  private constructor(
    readonly suffix: string,
    readonly handle: FileHandle,
    readonly size: number,
    /** Device, inode, size, and nanosecond change times of the file as opened. */
    readonly identity: string,
  ) {}

  static async open(path: string, suffix: string): Promise<CacheFile> {
    const handle = await open(
      await realpath(path),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const metadata = await handle.stat({ bigint: true });
      if (!metadata.isFile())
        throw new ArtifactReaderFailure(
          "path",
          `Dyld cache path is not a regular file: ${path}`,
        );
      return new CacheFile(
        suffix,
        handle,
        safeNumber(metadata.size, "file size"),
        CacheFile.identify(metadata),
      );
    } catch (cause: unknown) {
      await handle.close();
      throw cause;
    }
  }

  static identify(metadata: {
    readonly dev: bigint;
    readonly ino: bigint;
    readonly size: bigint;
    readonly mtimeNs: bigint;
    readonly ctimeNs: bigint;
  }): string {
    return [
      metadata.dev,
      metadata.ino,
      metadata.size,
      metadata.mtimeNs,
      metadata.ctimeNs,
    ].join(":");
  }

  /** Whether the open file still matches the identity recorded at open. */
  async unchanged(): Promise<boolean> {
    return (
      CacheFile.identify(await this.handle.stat({ bigint: true })) ===
      this.identity
    );
  }

  async read(offset: number, length: number): Promise<Buffer> {
    if (offset < 0 || offset + length > this.size)
      throw new ArtifactReaderFailure(
        "format",
        `dyld cache read at ${hex(offset)} extends beyond ${this.suffix === "" ? "the main file" : `subcache ${this.suffix}`}`,
      );
    if (length > BLOCK_BYTES) {
      const bytes = Buffer.alloc(length);
      await this.readInto(bytes, 0, length, offset);
      return bytes;
    }
    const chunks: Buffer[] = [];
    for (let position = offset; position < offset + length;) {
      const index = Math.floor(position / BLOCK_BYTES);
      let block = this.#blocks.get(index);
      if (block === undefined) {
        const start = index * BLOCK_BYTES;
        block = Buffer.alloc(Math.min(BLOCK_BYTES, this.size - start));
        await this.readInto(block, 0, block.length, start);
        this.#blocks.set(index, block);
      }
      const from = position - index * BLOCK_BYTES;
      const take = Math.min(block.length - from, offset + length - position);
      chunks.push(block.subarray(from, from + take));
      position += take;
    }
    return chunks.length === 1
      ? (chunks[0] ?? Buffer.alloc(0))
      : Buffer.concat(chunks);
  }

  /** Positional read that retries short reads; slow filesystems may return partial data. */
  private async readInto(
    target: Buffer,
    targetOffset: number,
    length: number,
    position: number,
  ): Promise<void> {
    let done = 0;
    while (done < length) {
      const { bytesRead } = await this.handle.read(
        target,
        targetOffset + done,
        length - done,
        position + done,
      );
      if (bytesRead === 0)
        throw new ArtifactReaderFailure(
          "format",
          `dyld cache read at ${hex(position)} is truncated`,
        );
      done += bytesRead;
    }
  }

  async cString(offset: number): Promise<string> {
    const bytes = await this.read(
      offset,
      Math.min(MAX_PATH_BYTES, this.size - offset),
    );
    const end = bytes.indexOf(0);
    if (end < 0)
      throw new ArtifactReaderFailure(
        "format",
        `dyld cache string at ${hex(offset)} is unterminated`,
      );
    return bytes.toString("utf8", 0, end);
  }
}

interface CacheRegion {
  readonly file: CacheFile;
  readonly address: number;
  readonly size: number;
  readonly fileOffset: number;
}

/** Validated disjoint regions are sorted once; all VM lookups use logarithmic search. */
const cacheRegionAt = (
  regions: readonly CacheRegion[],
  address: number,
): CacheRegion | undefined => {
  let low = 0;
  let high = regions.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const region = regions[middle];
    if (region !== undefined && region.address <= address) low = middle + 1;
    else high = middle;
  }
  const region = regions[low - 1];
  return region !== undefined && address < region.address + region.size
    ? region
    : undefined;
};

interface ParsedHeader {
  readonly magic: string;
  readonly uuid: string;
  readonly mappings: readonly {
    readonly address: bigint;
    readonly size: bigint;
    readonly fileOffset: bigint;
    readonly maxProt: number;
    readonly initProt: number;
  }[];
  readonly header: Buffer;
  readonly length: number;
}

const has = (parsed: ParsedHeader, offset: number, width: number): boolean =>
  parsed.length >= offset + width;

const readHeader = async (file: CacheFile): Promise<ParsedHeader> => {
  if (file.size < 0x20)
    throw new ArtifactReaderFailure(
      "format",
      "File is too short to be a dyld shared cache",
    );
  const prefix = await file.read(0, 0x20);
  const magic = prefix.toString("latin1", 0, 16).replace(/\0+$/u, "");
  if (!magic.startsWith(MAGIC_PREFIX))
    throw new ArtifactReaderFailure(
      "format",
      "File is not a dyld shared cache",
    );
  const mappingOffset = prefix.readUInt32LE(FIELD.mappingOffset);
  const mappingCount = prefix.readUInt32LE(FIELD.mappingCount);
  if (
    mappingOffset < 0x20 ||
    mappingOffset > MAX_HEADER_BYTES ||
    mappingCount === 0 ||
    mappingCount > MAX_MAPPINGS
  )
    throw new ArtifactReaderFailure(
      "format",
      "dyld cache header has an invalid mapping table",
    );
  const header = await file.read(0, mappingOffset);
  const table = await file.read(mappingOffset, mappingCount * 32);
  const mappings = Array.from({ length: mappingCount }, (_, index) => ({
    address: table.readBigUInt64LE(index * 32),
    size: table.readBigUInt64LE(index * 32 + 8),
    fileOffset: table.readBigUInt64LE(index * 32 + 16),
    maxProt: table.readUInt32LE(index * 32 + 24),
    initProt: table.readUInt32LE(index * 32 + 28),
  }));
  const parsed = { magic, uuid: "", mappings, header, length: mappingOffset };
  return {
    ...parsed,
    uuid: has(parsed, FIELD.uuid, 16)
      ? uuidText(header.subarray(FIELD.uuid, FIELD.uuid + 16))
      : "",
  };
};

const cacheArchitecture = (magic: string): string =>
  magic.slice(MAGIC_PREFIX.length).trim();

/** Lowest mapping address: the subcache base `cacheVMOffset` is measured from. */
const mappingBase = (parsed: ParsedHeader): bigint => {
  const first = parsed.mappings[0];
  if (first === undefined)
    throw new ArtifactReaderFailure("format", "dyld cache has no mappings");
  return parsed.mappings.reduce(
    (lowest, mapping) => (mapping.address < lowest ? mapping.address : lowest),
    first.address,
  );
};

const version = (value: number): string | null =>
  value === 0
    ? null
    : `${value >>> 16}.${(value >>> 8) & 0xff}.${value & 0xff}`;

/** dyld_cache_header.formatBits simulator bit follows the 8-bit version and disk flag. */
const SIMULATOR_CACHE_FLAG = 1 << 9;
const SIMULATOR_PLATFORMS: ReadonlyMap<number, number> = new Map([
  [2, 7],
  [3, 8],
  [4, 9],
  [11, 12],
]);

const cachePlatform = (id: number | null, simulator: boolean | null) =>
  id === null
    ? null
    : applePlatform(
        simulator === true ? (SIMULATOR_PLATFORMS.get(id) ?? id) : id,
      );

/**
 * Decode `cacheType` according to header generation. Modern headers
 * (those carrying `cacheSubType`) use `0 = development`, `1 = production`;
 * older single-file headers use the historical `1 = development`,
 * `0 = optimized` polarity.
 */
const decodeCacheType = (
  cacheType: number | null,
  modern: boolean,
): DyldSharedCacheHeader["cache_type"] => {
  if (cacheType === null) return null;
  if (modern)
    return cacheType === 0
      ? "development"
      : cacheType === 1
        ? "production"
        : cacheType === 2
          ? "multi-cache"
          : null;
  return cacheType === 1
    ? "development"
    : cacheType === 0
      ? "production"
      : null;
};

/** A main dyld shared cache file and the subcaches it names. */
export class DyldSharedCache {
  readonly #byPath: ReadonlyMap<
    string,
    { readonly path: string; readonly address: number }
  >;

  private constructor(
    readonly header: DyldSharedCacheHeader,
    readonly images: readonly {
      readonly path: string;
      readonly address: number;
    }[],
    private readonly files: readonly CacheFile[],
    private readonly regions: readonly CacheRegion[],
  ) {
    this.#byPath = new Map(images.map((image) => [image.path, image]));
  }

  /** Open the main cache file and every subcache beside it. */
  static async open(
    path: string,
    signal?: AbortSignal,
  ): Promise<DyldSharedCache> {
    // Inspection and tracing share this boundary: companion discovery follows
    // the actual main cache file, while adapters keep the selected path spelling.
    const canonicalPath = await realpath(path);
    const main = await CacheFile.open(canonicalPath, "");
    const files = [main];
    try {
      const parsed = await readHeader(main);
      const { named, entries: subcaches } =
        await DyldSharedCache.#subcacheEntries(main, parsed);
      // With named suffixes, dyld strips a development main file's extension
      // first: dyld_shared_cache_arm64e.development -> dyld_shared_cache_arm64e.01.development.
      const base =
        named && canonicalPath.endsWith(DEVELOPMENT_EXTENSION)
          ? canonicalPath.slice(0, -DEVELOPMENT_EXTENSION.length)
          : canonicalPath;
      const statuses: DyldCacheSubcache[] = [];
      const parsedFiles = [{ file: main, parsed }];
      for (const entry of subcaches) {
        signal?.throwIfAborted();
        let file: CacheFile;
        try {
          file = await CacheFile.open(`${base}${entry.suffix}`, entry.suffix);
        } catch (cause: unknown) {
          if (
            cause instanceof Error &&
            "code" in cause &&
            cause.code === "ENOENT"
          ) {
            statuses.push({ ...entry, status: "missing", observed_uuid: null });
            continue;
          }
          throw cause;
        }
        files.push(file);
        const subParsed = await readHeader(file);
        // UUID, architecture, and VM offset are one admission decision.
        // A later overlap or image-address check cannot repair a companion
        // that already contradicts the main header.
        const status = DyldSharedCache.#admitSubcache(parsed, entry, subParsed);
        statuses.push({
          ...entry,
          status,
          observed_uuid: subParsed.uuid,
        });
        if (status === "present") parsedFiles.push({ file, parsed: subParsed });
      }
      const header = DyldSharedCache.#summary(parsed, parsedFiles, statuses);
      const images = await DyldSharedCache.#images(main, parsed, signal);
      const regions = parsedFiles.flatMap(({ file, parsed: item }) =>
        item.mappings.map((mapping) => {
          const fileOffset = safeNumber(
            mapping.fileOffset,
            "mapping file offset",
          );
          const size = safeNumber(mapping.size, "mapping size");
          const address = safeNumber(mapping.address, "mapping address");
          // A truncated file that declares mappings beyond its bytes cannot
          // map those addresses; drop the unverified extent.
          if (
            fileOffset < 0 ||
            size <= 0 ||
            fileOffset + size > file.size ||
            !Number.isSafeInteger(address + size)
          )
            throw new ArtifactReaderFailure(
              "format",
              `dyld cache mapping in ${file.suffix === "" ? "the main file" : `subcache ${file.suffix}`} extends beyond its file`,
            );
          return {
            file,
            address,
            size,
            fileOffset,
          };
        }),
      );
      const ordered = regions.toSorted(
        (left, right) => left.address - right.address,
      );
      for (let index = 1; index < ordered.length; index++) {
        const previous = ordered[index - 1];
        const current = ordered[index];
        if (
          previous !== undefined &&
          current !== undefined &&
          current.address < previous.address + previous.size
        )
          throw new ArtifactReaderFailure(
            "format",
            `Dyld cache VM mappings overlap at ${hex(current.address)} between ${previous.file.suffix || "main"} and ${current.file.suffix || "main"}`,
          );
      }
      if (statuses.every(({ status }) => status === "present")) {
        const unmapped = images.find(
          ({ address }) => cacheRegionAt(ordered, address) === undefined,
        );
        if (unmapped !== undefined)
          throw new ArtifactReaderFailure(
            "format",
            `Complete dyld cache has an unmapped image address ${hex(unmapped.address)}: ${unmapped.path}`,
          );
      }
      return new DyldSharedCache(header, images, files, ordered);
    } catch (cause: unknown) {
      await Promise.allSettled(files.map(({ handle }) => handle.close()));
      throw cause;
    }
  }

  static async #subcacheEntries(
    main: CacheFile,
    parsed: ParsedHeader,
  ): Promise<{
    /** Entries carry explicit file suffixes (dyld_subcache_entry v2). */
    readonly named: boolean;
    readonly entries: {
      readonly suffix: string;
      readonly uuid: string;
      readonly vm_offset: string;
    }[];
  }> {
    if (!has(parsed, FIELD.subCacheArrayCount, 4))
      return { named: false, entries: [] };
    const offset = parsed.header.readUInt32LE(FIELD.subCacheArrayOffset);
    const count = parsed.header.readUInt32LE(FIELD.subCacheArrayCount);
    // Headers that include cacheSubType use entries with an explicit file suffix.
    const named = has(parsed, FIELD.cacheSubType, 4);
    if (count === 0) return { named, entries: [] };
    if (count > MAX_SUBCACHES)
      throw new ArtifactReaderFailure(
        "format",
        "dyld cache lists too many subcaches",
      );
    const size = named ? 56 : 24;
    const table = await main.read(offset, count * size);
    const entries = Array.from({ length: count }, (_, index) => {
      const base = index * size;
      const suffix = named
        ? table.toString("latin1", base + 24, base + 56).replace(/\0.*$/su, "")
        : `.${index + 1}`;
      if (!/^\.[A-Za-z0-9.]+$/u.test(suffix))
        throw new ArtifactReaderFailure(
          "format",
          "dyld subcache has an unsafe file suffix",
        );
      return {
        suffix,
        uuid: uuidText(table.subarray(base, base + 16)),
        vm_offset: hex(table.readBigUInt64LE(base + 16)),
      };
    });
    return { named, entries };
  }

  /**
   * Whether a companion file is the subcache the main header named.
   * UUID, magic, and `cacheVMOffset` are checked together; failure to match
   * the UUID leaves the cache partial, while a matching UUID that contradicts
   * the main header is a format error and contributes no mappings.
   */
  static #admitSubcache(
    main: ParsedHeader,
    entry: {
      readonly suffix: string;
      readonly uuid: string;
      readonly vm_offset: string;
    },
    sub: ParsedHeader,
  ): "present" | "uuid-mismatch" {
    if (sub.uuid !== entry.uuid) return "uuid-mismatch";
    if (sub.magic !== main.magic)
      throw new ArtifactReaderFailure(
        "format",
        `dyld subcache ${entry.suffix} architecture ${cacheArchitecture(sub.magic)} does not match the main cache architecture ${cacheArchitecture(main.magic)}`,
      );
    const mainBase = mappingBase(main);
    const actual = mappingBase(sub);
    const expected = mainBase + BigInt(entry.vm_offset);
    if (actual !== expected)
      throw new ArtifactReaderFailure(
        "format",
        `dyld subcache ${entry.suffix} mapping base ${hex(actual)} disagrees with cache VM offset ${entry.vm_offset} from main base ${hex(mainBase)}`,
      );
    return "present";
  }

  static #summary(
    parsed: ParsedHeader,
    files: readonly {
      readonly file: CacheFile;
      readonly parsed: ParsedHeader;
    }[],
    subcaches: readonly DyldCacheSubcache[],
  ): DyldSharedCacheHeader {
    const header = parsed.header;
    const u32 = (offset: number): number | null =>
      has(parsed, offset, 4) ? header.readUInt32LE(offset) : null;
    const u64 = (offset: number): string | null =>
      has(parsed, offset, 8) ? hex(header.readBigUInt64LE(offset)) : null;
    const platform = u32(FIELD.platform);
    const altPlatform = u32(FIELD.altPlatform);
    const formatBits = u32(FIELD.formatBits);
    const simulator =
      formatBits === null ? null : (formatBits & SIMULATOR_CACHE_FLAG) !== 0;
    const cacheType = has(parsed, FIELD.cacheType, 8)
      ? Number(header.readBigUInt64LE(FIELD.cacheType))
      : null;
    const symbols = has(parsed, FIELD.symbolFileUuid, 16)
      ? header.subarray(FIELD.symbolFileUuid, FIELD.symbolFileUuid + 16)
      : undefined;
    const mappings: DyldCacheMapping[] = files.flatMap(
      ({ file, parsed: item }) =>
        item.mappings.map((mapping) => ({
          file: file.suffix,
          address: hex(mapping.address),
          size: hex(mapping.size),
          file_offset: hex(mapping.fileOffset),
          max_protection: mapping.maxProt,
          initial_protection: mapping.initProt,
        })),
    );
    return {
      magic: parsed.magic,
      architecture: cacheArchitecture(parsed.magic),
      uuid: parsed.uuid,
      platform: cachePlatform(platform, simulator),
      header_platform: platform === null ? null : applePlatform(platform),
      header_alt_platform:
        altPlatform === null || altPlatform === 0
          ? null
          : applePlatform(altPlatform),
      simulator,
      os_version: version(u32(FIELD.osVersion) ?? 0),
      alt_platform:
        altPlatform === null || altPlatform === 0
          ? null
          : cachePlatform(altPlatform, simulator),
      alt_os_version: version(u32(FIELD.altOsVersion) ?? 0),
      cache_type: decodeCacheType(
        cacheType,
        has(parsed, FIELD.cacheSubType, 4),
      ),
      shared_region:
        u64(FIELD.sharedRegionStart) === null
          ? null
          : {
              start: u64(FIELD.sharedRegionStart) ?? "0x0",
              size: u64(FIELD.sharedRegionSize) ?? "0x0",
            },
      max_slide: u64(FIELD.maxSlide),
      mappings,
      subcaches: [...subcaches],
      symbols_file_uuid:
        symbols === undefined || symbols.every((byte) => byte === 0)
          ? null
          : uuidText(symbols),
    };
  }

  static async #images(
    main: CacheFile,
    parsed: ParsedHeader,
    signal?: AbortSignal,
  ): Promise<{ readonly path: string; readonly address: number }[]> {
    const modern = has(parsed, FIELD.imagesCount, 4);
    const offset = parsed.header.readUInt32LE(
      modern ? FIELD.imagesOffset : FIELD.imagesOffsetOld,
    );
    const count = parsed.header.readUInt32LE(
      modern ? FIELD.imagesCount : FIELD.imagesCountOld,
    );
    if (count > MAX_IMAGES)
      throw new ArtifactReaderFailure(
        "limit",
        `dyld cache lists more than ${MAX_IMAGES} images`,
      );
    const table = await main.read(offset, count * 32);
    const images: { path: string; address: number }[] = [];
    for (let index = 0; index < count; index++) {
      if (index % 512 === 0) signal?.throwIfAborted();
      images.push({
        address: safeNumber(table.readBigUInt64LE(index * 32), "image address"),
        path: await main.cString(table.readUInt32LE(index * 32 + 24)),
      });
    }
    return images;
  }

  /** Locate an image by its exact install path. */
  find(
    path: string,
  ): { readonly path: string; readonly address: number } | undefined {
    return this.#byPath.get(path);
  }

  /**
   * Whether an install path is listed and its address lies in a mapping of an
   * admitted file. This is address coverage: `imageFacts` has to parse a
   * compatible Mach-O before the path is a shared-cache load.
   */
  locate(path: string): "mapped" | "unverified" | "absent" {
    const image = this.find(path);
    if (image === undefined) return "absent";
    return this.#region(image.address) === undefined ? "unverified" : "mapped";
  }

  #region(address: number) {
    return cacheRegionAt(this.regions, address);
  }

  /** Parse one cached image's load commands through the cache's VM mappings. */
  async imageFacts(
    path: string,
  ): Promise<
    { readonly file: string; readonly facts: MachoImageFacts } | undefined
  > {
    const image = this.find(path);
    if (image === undefined) return undefined;
    const region = this.#region(image.address);
    if (region === undefined) return undefined;
    const base = region.fileOffset + (image.address - region.address);
    const available = region.size - (image.address - region.address);
    const facts = await readMachoImage(
      async (offset, length) =>
        region.file.read(
          base + offset,
          Math.max(0, Math.min(length, available - offset)),
        ),
      available,
    );
    return { file: region.file.suffix, facts };
  }

  /** Digest of the main file through the handle its header was parsed from. */
  async mainSha256(signal?: AbortSignal): Promise<string> {
    const main = this.files[0];
    if (main === undefined)
      throw new ArtifactReaderFailure("format", "dyld cache has no main file");
    return this.hashFile(main, signal);
  }

  /** SHA-256 of every readable subcache, keyed by suffix, through their open handles. */
  async subcacheSha256(signal?: AbortSignal): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const file of this.files.slice(1)) {
      signal?.throwIfAborted();
      out[file.suffix] = await this.hashFile(file, signal);
    }
    return out;
  }

  private async hashFile(
    file: CacheFile,
    signal?: AbortSignal,
  ): Promise<string> {
    // In-place rewrites through the same inode keep this handle valid, so a
    // digest is bound to its bytes only when the identity is unchanged.
    if (!(await file.unchanged()))
      throw new ArtifactReaderFailure(
        "integrity",
        "dyld cache file changed before its digest was read",
      );
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(HASH_CHUNK_BYTES);
    let position = 0;
    for (;;) {
      signal?.throwIfAborted();
      if (position >= file.size) break;
      const { bytesRead } = await file.handle.read(
        buffer,
        0,
        Math.min(buffer.length, file.size - position),
        position,
      );
      // A file truncated after open must not yield the surviving prefix's
      // digest as the identity of the recorded size.
      if (bytesRead === 0)
        throw new ArtifactReaderFailure(
          "integrity",
          "dyld cache file changed while its digest was read",
        );
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    if (position !== file.size)
      throw new ArtifactReaderFailure(
        "integrity",
        "dyld cache file changed while its digest was read",
      );
    if (!(await file.unchanged()))
      throw new ArtifactReaderFailure(
        "integrity",
        "dyld cache file changed while its digest was read",
      );
    return hash.digest("hex");
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.files.map(({ handle }) => handle.close()));
  }
}
