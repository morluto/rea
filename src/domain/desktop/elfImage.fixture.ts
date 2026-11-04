/** What a synthetic little-endian ELF64 image declares in its dynamic segment. */
export interface ElfImageSpec {
  readonly machine?: number;
  readonly needed?: readonly string[];
  readonly rpath?: string;
  readonly runpath?: string;
  /** Without a PT_DYNAMIC segment, as a static executable. */
  readonly static?: boolean;
  /** Leave the DT_NULL terminator out. */
  readonly unterminated?: boolean;
}

const HEADER = 64;
const PROGRAM = 56;

/**
 * A shared object laid out as the linker does for a small image: one PT_LOAD
 * mapping the file at address 0, a PT_DYNAMIC segment, and its string table.
 */
export const elfImage = (spec: ElfImageSpec): Buffer => {
  const strings = ["", ...(spec.needed ?? [])];
  if (spec.rpath !== undefined) strings.push(spec.rpath);
  if (spec.runpath !== undefined) strings.push(spec.runpath);
  const table = Buffer.from(`${strings.join("\0")}\0`, "latin1");
  const offsetOf = (value: string) =>
    BigInt(table.indexOf(Buffer.from(`\0${value}\0`, "latin1")) + 1);
  const entries: [bigint, bigint][] = [
    ...(spec.rpath === undefined
      ? []
      : [[15n, offsetOf(spec.rpath)] as [bigint, bigint]]),
    ...(spec.needed ?? []).map(
      (name) => [1n, offsetOf(name)] as [bigint, bigint],
    ),
    ...(spec.runpath === undefined
      ? []
      : [[29n, offsetOf(spec.runpath)] as [bigint, bigint]]),
  ];
  const programs = spec.static === true ? 1 : 2;
  const tableAt = HEADER + PROGRAM * programs;
  const dynamicAt = tableAt + table.length + ((8 - (table.length % 8)) % 8);
  entries.push([5n, BigInt(tableAt)], [10n, BigInt(table.length)]);
  if (spec.unterminated !== true) entries.push([0n, 0n]);
  const size = dynamicAt + entries.length * 16;
  const image = Buffer.alloc(size);
  image.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1], 0);
  image.writeUInt16LE(3, 16);
  image.writeUInt16LE(spec.machine ?? 183, 18);
  image.writeUInt32LE(1, 20);
  image.writeBigUInt64LE(BigInt(HEADER), 32);
  image.writeUInt16LE(HEADER, 52);
  image.writeUInt16LE(PROGRAM, 54);
  image.writeUInt16LE(programs, 56);
  const program = (
    index: number,
    type: number,
    offset: number,
    bytes: number,
  ) => {
    const at = HEADER + index * PROGRAM;
    image.writeUInt32LE(type, at);
    image.writeUInt32LE(4, at + 4);
    image.writeBigUInt64LE(BigInt(offset), at + 8);
    image.writeBigUInt64LE(BigInt(offset), at + 16);
    image.writeBigUInt64LE(BigInt(offset), at + 24);
    image.writeBigUInt64LE(BigInt(bytes), at + 32);
    image.writeBigUInt64LE(BigInt(bytes), at + 40);
  };
  program(0, 1, 0, size);
  if (spec.static !== true) program(1, 2, dynamicAt, entries.length * 16);
  table.copy(image, tableAt);
  entries.forEach(([tag, value], index) => {
    image.writeBigInt64LE(tag, dynamicAt + index * 16);
    image.writeBigUInt64LE(value, dynamicAt + index * 16 + 8);
  });
  return image;
};

/** A range reader over an in-memory image. */
export const readImage =
  (image: Buffer) =>
  async (offset: number, length: number): Promise<Uint8Array> =>
    image.subarray(offset, offset + length);
