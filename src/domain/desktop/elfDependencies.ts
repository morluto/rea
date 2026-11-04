import { readElfDynamicEntry } from "../elfDynamicEntry.js";
import { readElfFixedHeader } from "../elfFixedHeader.js";
import {
  readElfProgramHeader,
  type ElfProgramHeader,
} from "../elfProgramHeader.js";
import {
  elfStringTableText,
  observeElfStringTableEntry,
} from "../elfStringTable.js";
import { err, ok, type Result } from "../result.js";

/** Read up to `length` bytes at `offset`; fewer at the end of the file. */
export type ReadAt = (offset: number, length: number) => Promise<Uint8Array>;

/** What the dynamic linker needs to load an ELF image's dependencies. */
export interface ElfDependencies {
  readonly machine: number;
  readonly bits: 32 | 64;
  /** DT_NEEDED sonames in order. */
  readonly needed: readonly string[];
  /** DT_RUNPATH directories, or DT_RPATH ones when there is no DT_RUNPATH, as written. */
  readonly searchPaths: readonly string[];
}

const PT_LOAD = 1;
const PT_DYNAMIC = 2;
const DT_NEEDED = 1n;
const DT_STRTAB = 5n;
const DT_STRSZ = 10n;
const DT_RPATH = 15n;
const DT_RUNPATH = 29n;
const MAX_PROGRAM_HEADER_BYTES = 1024 * 1024;
const MAX_DYNAMIC_BYTES = 1024 * 1024;
const MAX_STRING_BYTES = 4096;

const readExactly = async (
  read: ReadAt,
  offset: bigint,
  length: bigint,
  size: number,
): Promise<Buffer | undefined> => {
  if (offset + length > BigInt(size)) return undefined;
  const bytes = await read(Number(offset), Number(length));
  return bytes.byteLength === Number(length) ? Buffer.from(bytes) : undefined;
};

/** The file offset of a virtual address inside a file-backed PT_LOAD segment. */
const fileOffset = (
  loads: readonly ElfProgramHeader[],
  address: bigint,
): bigint | undefined => {
  const load = loads.find(
    (segment) =>
      address >= segment.virtualAddress &&
      address < segment.virtualAddress + segment.fileSize,
  );
  return load === undefined
    ? undefined
    : load.offset + address - load.virtualAddress;
};

const programHeaders = async (
  read: ReadAt,
  header: Buffer,
  size: number,
  bits: 32 | 64,
): Promise<Result<readonly ElfProgramHeader[], string>> => {
  const little = header[5] === 1;
  const view = new DataView(header.buffer, header.byteOffset, header.length);
  const offset =
    bits === 64
      ? view.getBigUint64(32, little)
      : BigInt(view.getUint32(28, little));
  const entrySize = view.getUint16(bits === 64 ? 54 : 42, little);
  const count = view.getUint16(bits === 64 ? 56 : 44, little);
  if (entrySize < (bits === 64 ? 56 : 32) || count === 0xffff)
    return err("unsupported ELF program header table");
  if (entrySize * count > MAX_PROGRAM_HEADER_BYTES)
    return err("ELF program header table is too large");
  const table = await readExactly(
    read,
    offset,
    BigInt(entrySize * count),
    size,
  );
  if (table === undefined) return err("ELF program header table is truncated");
  const headers: ElfProgramHeader[] = [];
  for (let index = 0; index < count; index += 1) {
    const parsed = readElfProgramHeader(
      table.subarray(index * entrySize, (index + 1) * entrySize),
      bits,
      little,
    );
    if (!parsed.ok) return err(parsed.error.message);
    headers.push(parsed.value);
  }
  return ok(headers);
};

/** DT_NEEDED and search path string offsets, and the string table's address and size. */
const dynamicTags = (
  table: Buffer,
  bits: 32 | 64,
  little: boolean,
): Result<
  {
    readonly needed: readonly bigint[];
    readonly runpath: readonly bigint[];
    readonly rpath: readonly bigint[];
    readonly strtab: bigint | undefined;
    readonly strsz: bigint | undefined;
  },
  string
> => {
  const width = bits === 64 ? 16 : 8;
  const found = {
    needed: [] as bigint[],
    runpath: [] as bigint[],
    rpath: [] as bigint[],
    strtab: undefined as bigint | undefined,
    strsz: undefined as bigint | undefined,
  };
  for (let at = 0; at + width <= table.length; at += width) {
    const entry = readElfDynamicEntry(
      table.subarray(at, at + width),
      bits,
      little,
    );
    if (!entry.ok) return err(entry.error.message);
    const { tag, value } = entry.value;
    if (tag === 0n) return ok(found);
    if (tag === DT_NEEDED) found.needed.push(value);
    else if (tag === DT_RUNPATH) found.runpath.push(value);
    else if (tag === DT_RPATH) found.rpath.push(value);
    else if (tag === DT_STRTAB) found.strtab = value;
    else if (tag === DT_STRSZ) found.strsz = value;
  }
  return err("ELF dynamic table has no DT_NULL terminator");
};

/**
 * The sonames an ELF image needs and the directories its RUNPATH or RPATH
 * names, read from its dynamic segment through the shared ELF readers.
 * A static image has no dependencies.
 */
export const readElfDependencies = async (
  read: ReadAt,
  size: number,
): Promise<Result<ElfDependencies, string>> => {
  const header = Buffer.from(await read(0, 64));
  const fixed = readElfFixedHeader(header, size);
  if (!fixed.ok) return fixed;
  const { elfClass: bits, machine } = fixed.value;
  const little = fixed.value.byteOrder === "little";
  const headers = await programHeaders(read, header, size, bits);
  if (!headers.ok) return headers;
  const dynamic = headers.value.find((program) => program.type === PT_DYNAMIC);
  if (dynamic === undefined)
    return ok({ machine, bits, needed: [], searchPaths: [] });
  if (dynamic.fileSize > BigInt(MAX_DYNAMIC_BYTES))
    return err("ELF dynamic table is too large");
  const table = await readExactly(read, dynamic.offset, dynamic.fileSize, size);
  if (table === undefined) return err("ELF dynamic table is truncated");
  const tags = dynamicTags(table, bits, little);
  if (!tags.ok) return tags;
  const { strtab, strsz, needed, runpath, rpath } = tags.value;
  const stringsAt =
    strtab === undefined
      ? undefined
      : fileOffset(
          headers.value.filter((program) => program.type === PT_LOAD),
          strtab,
        );
  if (stringsAt === undefined || strsz === undefined)
    return needed.length + runpath.length + rpath.length === 0
      ? ok({ machine, bits, needed: [], searchPaths: [] })
      : err("ELF dynamic string table is not mapped from the file");
  const text = async (offset: bigint): Promise<Result<string, string>> => {
    if (offset >= strsz)
      return err("ELF dynamic string lies outside its table");
    const length =
      BigInt(MAX_STRING_BYTES) < strsz - offset
        ? BigInt(MAX_STRING_BYTES)
        : strsz - offset;
    const window = await readExactly(read, stringsAt + offset, length, size);
    const value =
      window === undefined
        ? null
        : elfStringTableText(
            observeElfStringTableEntry(window, 0, MAX_STRING_BYTES),
          );
    return value === null ? err("ELF dynamic string is truncated") : ok(value);
  };
  const strings: string[] = [];
  for (const offset of [...needed, ...(runpath.length > 0 ? runpath : rpath)]) {
    const value = await text(offset);
    if (!value.ok) return value;
    strings.push(value.value);
  }
  return ok({
    machine,
    bits,
    needed: strings.slice(0, needed.length),
    searchPaths: strings
      .slice(needed.length)
      .flatMap((paths) => paths.split(":"))
      .filter((path) => path.length > 0),
  });
};
