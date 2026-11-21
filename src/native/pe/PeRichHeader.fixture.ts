/** One `@comp.id` record written into a fixture Rich header. */
export interface RichFixtureEntry {
  readonly productId: number;
  readonly build: number;
  readonly count: number;
}

/** Entry values chosen for these tests; they do not name real tools. */
export const RICH_FIXTURE_ENTRIES: readonly RichFixtureEntry[] = [
  { productId: 0x0101, build: 0x7809, count: 7 },
  { productId: 0x0104, build: 0x8179, count: 43 },
  { productId: 0x0001, build: 0, count: 300 },
];

const DANS = 0x536e6144;
const RICH = 0x68636952;
const DOS_HEADER_BYTES = 0x40;

/** A synthetic DOS stub that only fills the space a real stub occupies. */
export const RICH_FIXTURE_STUB = Buffer.alloc(0x40, 0x90);
Buffer.from("REA fixture DOS stub.\r\n$", "latin1").copy(RICH_FIXTURE_STUB, 8);

const rotate = (value: bigint, shift: number): bigint => {
  const bits = BigInt(shift % 32);
  return ((value << bits) | (value >> (32n - bits))) & 0xffffffffn;
};

/**
 * Independent BigInt form of the linker checksum over `prefix` (everything
 * before `DanS`) and the entries, kept apart from the production decoder.
 */
export const richFixtureChecksum = (
  prefix: Buffer,
  entries: readonly RichFixtureEntry[],
): number => {
  let sum = BigInt(prefix.length);
  prefix.forEach((byte, index) => {
    if (index < 0x3c || index >= DOS_HEADER_BYTES)
      sum += rotate(BigInt(byte), index);
  });
  for (const { productId, build, count } of entries)
    sum += rotate(BigInt(productId) * 0x10000n + BigInt(build), count);
  return Number(sum & 0xffffffffn);
};

/** Encode one Rich block: `DanS`, padding, entries, then `Rich` and the key. */
export const richFixtureBlock = (
  entries: readonly RichFixtureEntry[],
  key: number,
  options: {
    readonly padding?: readonly [number, number, number];
    readonly omitStart?: boolean;
    readonly extraDword?: boolean;
  } = {},
): Buffer => {
  const block = Buffer.alloc(
    16 + entries.length * 8 + (options.extraDword === true ? 4 : 0) + 8,
  );
  const encode = (value: number, at: number) =>
    block.writeUInt32LE((value ^ key) >>> 0, at);
  encode(options.omitStart === true ? 0x12345678 : DANS, 0);
  (options.padding ?? [0, 0, 0]).forEach((value, index) =>
    encode(value, 4 + index * 4),
  );
  entries.forEach(({ productId, build, count }, index) => {
    encode(((productId << 16) | build) >>> 0, 16 + index * 8);
    encode(count, 20 + index * 8);
  });
  block.writeUInt32LE(RICH, block.length - 8);
  block.writeUInt32LE(key >>> 0, block.length - 4);
  return block;
};

export interface RichFixtureOptions {
  readonly plus?: boolean;
  readonly stub?: Buffer;
  readonly entries?: readonly RichFixtureEntry[];
  /** Stored key; the default is the checksum, so the record verifies. */
  readonly key?: number;
  readonly padding?: readonly [number, number, number];
  /** Write no Rich block at all. */
  readonly block?: boolean;
  readonly omitStart?: boolean;
  readonly extraDword?: boolean;
  /**
   * Put the PE signature here instead of after the stub and record. Below
   * 0x40 it overlaps the DOS header and no stub is written; use it with
   * `block: false`. At 0x30, e_lfanew doubles as PointerToSymbolTable.
   */
  readonly peOffset?: number;
}

/**
 * Minimal PE32/PE32+ image: DOS header, stub, optional Rich block, then the
 * PE signature, COFF and optional headers and one empty section header.
 */
export const peRichHeaderImage = (options: RichFixtureOptions = {}): Buffer => {
  const plus = options.plus ?? true;
  const stub = options.stub ?? RICH_FIXTURE_STUB;
  const entries = options.entries ?? RICH_FIXTURE_ENTRIES;
  const start = DOS_HEADER_BYTES + stub.length;
  if (start % 4 !== 0) throw new Error("Fixture Rich blocks are DWORD aligned");
  const blockBytes =
    options.block === false
      ? 0
      : 16 + entries.length * 8 + (options.extraDword === true ? 4 : 0) + 8;
  const peOffset = options.peOffset ?? Math.ceil((start + blockBytes) / 8) * 8;
  const optionalSize = plus ? 240 : 224;
  const headerBytes =
    Math.ceil((peOffset + 24 + optionalSize + 40) / 0x200) * 0x200;
  const bytes = Buffer.alloc(headerBytes);
  bytes.writeUInt16LE(0x5a4d, 0);
  bytes.writeUInt32LE(peOffset, 0x3c);
  if (peOffset >= DOS_HEADER_BYTES) stub.copy(bytes, DOS_HEADER_BYTES);
  if (options.block !== false) {
    const key =
      options.key ?? richFixtureChecksum(bytes.subarray(0, start), entries);
    richFixtureBlock(entries, key, options).copy(bytes, start);
  }
  bytes.writeUInt32LE(0x4550, peOffset);
  bytes.writeUInt16LE(plus ? 0x8664 : 0x14c, peOffset + 4);
  bytes.writeUInt16LE(1, peOffset + 6);
  bytes.writeUInt16LE(optionalSize, peOffset + 20);
  const optional = peOffset + 24;
  bytes.writeUInt16LE(plus ? 0x20b : 0x10b, optional);
  bytes.writeUInt32LE(headerBytes, optional + 60);
  bytes.writeUInt32LE(16, optional + (plus ? 108 : 92));
  return bytes;
};
