import { createHash } from "node:crypto";

/**
 * Byte-level Unreal pak builder for parser tests. It writes a data area of
 * zeros, an index and a footer in the layout of the selected version; file
 * contents are never read by the parser, so only their sizes matter.
 */

export type PakFixtureLayout =
  | "v1"
  | "v3"
  | "v4"
  | "v7"
  | "v8a"
  | "v8b"
  | "v9"
  | "v10"
  | "v11"
  | "v12";

export interface PakFixtureFile {
  readonly path: string;
  readonly size: number;
  /** Compressed with the first named method; uncompressed size is size * 2. */
  readonly compressed?: boolean;
  /** Version 10+: store as a full record in the non-encoded list. */
  readonly fullRecord?: boolean;
  /** Compressed only: number of 64 KiB blocks (default 1). */
  readonly blocks?: number;
  readonly encrypted?: boolean;
  /** Full records only. */
  readonly deleted?: boolean;
}

export interface PakFixtureOptions {
  readonly layout: PakFixtureLayout;
  readonly files?: readonly PakFixtureFile[];
  readonly mountPoint?: string;
  readonly encryptedIndex?: boolean;
  readonly frozenIndex?: boolean;
  /** Version 10+: write the path hash index, the full directory index, or both. */
  readonly pathHashIndex?: boolean;
  readonly directoryIndex?: boolean;
  /** Bytes appended after the path hash index or the directory index content. */
  readonly pathHashTrailer?: Buffer;
  /** Repeat the full directory listing as the pruned one instead of leaving it empty. */
  readonly prunedListing?: boolean;
  readonly directoryTrailer?: Buffer;
  /** Version 10+: the entry count written in the index header. */
  readonly declaredEntries?: number;
  /** Version 10+: replace the first file's entry reference. */
  readonly firstReference?: number;
  /** Move the last file's recorded offset by this many bytes. */
  readonly lastOffsetShift?: number;
  /**
   * Version 10+: append one unlisted encoded record at this data offset and
   * point the first path-hash row at it, leaving the directory listings intact.
   */
  readonly strayHashOffset?: number;
  /** Version 10+: empty directories added to the full directory index. */
  readonly emptyDirectories?: number;
  /** Name stem of the empty directories (default "/Empty"). */
  readonly emptyDirectoryName?: string;
  /** Version 10+: write directory names, empty ones too, without their closing slash. */
  readonly unslashedDirectories?: boolean;
  /** Version 10+: the full directory index lists file `at` with another file's reference. */
  readonly directoryReference?: { readonly at: number; readonly from: number };
  /** Version 10+: flip one bit of the first path hash. */
  readonly mismatchedPathHash?: boolean;
  /** Version 10+: compressed encoded records appended that no listing references. */
  readonly unreferencedRecords?: number;
  /** Version 1: the FDateTime tick count every record stores (default 0). */
  readonly timestamp?: bigint;
}

export const PAK_FIXTURE_FILES: readonly PakFixtureFile[] = [
  { path: "Game/Config/DefaultGame.ini", size: 40 },
  { path: "Game/Content/Maps/Main.umap", size: 300, compressed: true },
  { path: "Game/Content/한글.txt", size: 12 },
];

const MAGIC = 0x5a6f12e1;

const versionOf = (layout: PakFixtureLayout) =>
  layout === "v8a" || layout === "v8b" ? 8 : Number(layout.slice(1));

const u32 = (value: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(value);
  return b;
};
const i32 = (value: number) => {
  const b = Buffer.alloc(4);
  b.writeInt32LE(value);
  return b;
};
const u64 = (value: number | bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(value));
  return b;
};

/** FString: ASCII as positive Latin-1 bytes, anything else as negative UTF-16 units. */
export const fstring = (value: string): Buffer => {
  if (/^[\x00-\x7f]*$/u.test(value))
    return Buffer.concat([
      u32(value.length + 1),
      Buffer.from(`${value}\0`, "latin1"),
    ]);
  const units = Buffer.from(`${value}\0`, "utf16le");
  return Buffer.concat([i32(-(units.length / 2)), units]);
};

/** Version 12 directory-index file name: UTF-8 byte count, no NUL. */
const utf8Name = (value: string) => {
  const bytes = Buffer.from(value, "utf8");
  return Buffer.concat([u32(bytes.length), bytes]);
};

const sha1 = (seed: number) => Buffer.alloc(20, seed & 0xff);
const digest = (bytes: Buffer) => createHash("sha1").update(bytes).digest();

interface Placed extends PakFixtureFile {
  readonly offset: number;
  readonly stored: number;
  readonly uncompressed: number;
  readonly method: number;
}

const fullRecord = (
  version: number,
  layout: PakFixtureLayout,
  file: Placed,
  seed: number,
  timestamp = 0n,
) => {
  const parts = [
    u64(file.offset),
    u64(file.stored),
    u64(file.uncompressed),
    layout === "v8a" ? Buffer.of(file.method) : u32(file.method),
  ];
  if (version === 1) parts.push(u64(timestamp));
  parts.push(sha1(seed));
  if (version >= 3) {
    if (file.method !== 0) {
      const blocks = file.blocks ?? 1;
      parts.push(u32(blocks));
      for (let b = 0; b < blocks; b++) parts.push(u64(b), u64(b + 1));
    }
    parts.push(
      Buffer.of(
        (file.encrypted === true ? 1 : 0) | (file.deleted === true ? 2 : 0),
      ),
      u32(file.method === 0 ? 0 : 65536),
    );
  }
  return Buffer.concat(parts);
};

const encodedRecord = (file: Placed) => {
  const blocks = file.method === 0 ? 0 : (file.blocks ?? 1);
  const encrypted = file.encrypted === true;
  const bits =
    (file.method === 0 ? 0 : 65536 >> 11) |
    (blocks << 6) |
    (encrypted ? 1 << 22 : 0) |
    (file.method << 23) |
    (1 << 29) |
    (1 << 30) |
    (1 << 31);
  const parts = [u32(bits >>> 0), u32(file.offset), u32(file.uncompressed)];
  if (file.method !== 0) parts.push(u32(file.stored));
  if (blocks > 1 || (blocks === 1 && encrypted))
    for (let b = 0; b < blocks; b++) parts.push(u32(1));
  return Buffer.concat(parts);
};

/**
 * FPakFile::HashPath for version 11+ (UE 5.8 PakFile.cpp): ASCII-lowercased
 * UTF-16LE units, FNV-64 with the seed added to the offset basis. Version 10
 * paks get the same hash, as repak 0.2.3 writes them.
 */
const pathHash = (path: string, seed: bigint) => {
  const lower = path.replace(/[A-Z]/gu, (c) => c.toLowerCase());
  let hash = (0xcbf29ce484222325n + seed) & 0xffffffffffffffffn;
  for (const byte of Buffer.from(lower, "utf16le")) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash;
};

const PATH_HASH_SEED = 0x1234n;

const footer = (
  options: PakFixtureOptions,
  version: number,
  indexOffset: number,
  index: Buffer,
) => {
  const parts: Buffer[] = [];
  if (version >= 7) parts.push(Buffer.alloc(16));
  if (version >= 4)
    parts.push(Buffer.of(options.encryptedIndex === true ? 1 : 0));
  parts.push(
    u32(MAGIC),
    u32(version),
    u64(indexOffset),
    u64(index.length),
    digest(index),
  );
  if (version === 9)
    parts.push(Buffer.of(options.frozenIndex === true ? 1 : 0));
  const slots = version < 8 ? 0 : options.layout === "v8a" ? 4 : 5;
  for (let slot = 0; slot < slots; slot++) {
    const name = Buffer.alloc(32);
    if (slot === 0) name.write("Zlib", "latin1");
    parts.push(name);
  }
  return Buffer.concat(parts);
};

/** Compressed encoded records that no listing references. */
const unreferenced = (count: number) =>
  Array.from({ length: count }, () =>
    encodedRecord({
      path: "",
      size: 0,
      offset: 0,
      stored: 0,
      uncompressed: 0,
      method: 1,
    }),
  );

/** The reference the full directory index lists for file `at`. */
const listed = (
  options: PakFixtureOptions,
  references: readonly number[],
  at: number,
) =>
  references[
    options.directoryReference?.at === at ? options.directoryReference.from : at
  ]!;

/** Build one pak file; returns the bytes and the placed files for assertions. */
export const createPakFixture = (options: PakFixtureOptions) => {
  const version = versionOf(options.layout);
  const files = options.files ?? PAK_FIXTURE_FILES;
  const compressedMethod = version >= 8 ? 1 : 1; // slot 0 (Zlib) or legacy flag 1
  let cursor = 0;
  const placed: Placed[] = files.map((file) => {
    const method =
      file.compressed === true && version >= 3 ? compressedMethod : 0;
    const entry = {
      ...file,
      offset: cursor,
      stored: file.size,
      uncompressed: method === 0 ? file.size : file.size * 2,
      method,
    };
    cursor += file.size;
    return entry;
  });
  const shift = options.lastOffsetShift ?? 0;
  const lastAt = placed.length - 1;
  if (shift !== 0 && lastAt >= 0)
    placed[lastAt] = {
      ...placed[lastAt]!,
      offset: placed[lastAt]!.offset + shift,
    };
  const data = Buffer.alloc(cursor);
  const mount = fstring(options.mountPoint ?? "../../../");
  const regions: Buffer[] = [];
  let index: Buffer;
  if (version < 10) {
    index = Buffer.concat([
      mount,
      u32(placed.length),
      ...placed.flatMap((file, at) => [
        fstring(file.path),
        fullRecord(version, options.layout, file, at, options.timestamp),
      ]),
    ]);
  } else {
    const encodedParts: Buffer[] = [];
    const fullParts: Buffer[] = [];
    let encodedLength = 0;
    const references = placed.map((file, at) => {
      if (file.fullRecord === true) {
        fullParts.push(
          fullRecord(version, options.layout, file, at, options.timestamp),
        );
        return -fullParts.length;
      }
      const reference = encodedLength;
      const record = encodedRecord(file);
      encodedParts.push(record);
      encodedLength += record.length;
      return reference;
    });
    if (options.firstReference !== undefined)
      references[0] = options.firstReference;
    const hashReferences = [...references];
    if (options.strayHashOffset !== undefined) {
      hashReferences[0] = encodedLength;
      encodedParts.push(
        encodedRecord({
          ...placed[0]!,
          offset: options.strayHashOffset,
        }),
      );
    }
    for (const record of unreferenced(options.unreferencedRecords ?? 0))
      encodedParts.push(record);
    const encoded = Buffer.concat(encodedParts);
    // Region offsets are absolute, after the data area and the main index.
    const directories = new Map<string, [string, number][]>();
    placed.forEach((file, at) => {
      const slash = file.path.lastIndexOf("/");
      const directory = `/${file.path.slice(0, options.unslashedDirectories === true ? slash : slash + 1)}`;
      const list = directories.get(directory) ?? [];
      list.push([file.path.slice(slash + 1), listed(options, references, at)]);
      directories.set(directory, list);
    });
    for (let at = 0; at < (options.emptyDirectories ?? 0); at++)
      directories.set(
        `${options.emptyDirectoryName ?? "/Empty"}${at}${options.unslashedDirectories === true ? "" : "/"}`,
        [],
      );
    const fdi = Buffer.concat([
      u32(directories.size),
      ...[...directories].flatMap(([directory, list]) => [
        fstring(directory),
        u32(list.length),
        ...list.flatMap(([name, reference]) => [
          version >= 12 ? utf8Name(name) : fstring(name),
          i32(reference),
        ]),
      ]),
    ]);
    const fdiBytes = Buffer.concat([
      fdi,
      options.directoryTrailer ?? Buffer.alloc(0),
    ]);
    const phi = Buffer.concat([
      u32(placed.length),
      ...placed.flatMap((file, at) => [
        u64(
          pathHash(file.path, PATH_HASH_SEED) ^
            (at === 0 && options.mismatchedPathHash === true ? 1n : 0n),
        ),
        i32(hashReferences[at]!),
      ]),
      // An empty pruned directory index, as repak writes it.
      options.prunedListing === true ? fdi : u32(0),
      options.pathHashTrailer ?? Buffer.alloc(0),
    ]);
    const withPhi = options.pathHashIndex ?? true;
    const withFdi = options.directoryIndex ?? true;
    const head = (phiOffset: number, fdiOffset: number) =>
      Buffer.concat([
        mount,
        u32(options.declaredEntries ?? placed.length),
        u64(PATH_HASH_SEED),
        u32(withPhi ? 1 : 0),
        ...(withPhi ? [u64(phiOffset), u64(phi.length), digest(phi)] : []),
        u32(withFdi ? 1 : 0),
        ...(withFdi
          ? [u64(fdiOffset), u64(fdiBytes.length), digest(fdiBytes)]
          : []),
        u32(encoded.length),
        encoded,
        u32(fullParts.length),
        ...fullParts,
      ]);
    const indexLength = head(0, 0).length;
    const phiOffset = data.length + indexLength;
    const fdiOffset = phiOffset + (withPhi ? phi.length : 0);
    index = head(phiOffset, fdiOffset);
    if (withPhi) regions.push(phi);
    if (withFdi) regions.push(fdiBytes);
  }
  const bytes = Buffer.concat([
    data,
    index,
    ...regions,
    footer(options, version, data.length, index),
  ]);
  return {
    bytes,
    files: placed,
    indexOffset: data.length,
    indexSize: index.length,
  };
};
