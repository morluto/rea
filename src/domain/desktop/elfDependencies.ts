import {
  desktopLibraryLimit,
  desktopLibraryPolicy,
  type DesktopLibraryPolicy,
} from "./libraryPolicy.js";
import { readElfDynamicEntry } from "../elfDynamicEntry.js";
import {
  admitElfFixedHeaderFacts,
  readElfHeaderFacts,
} from "../elfFixedHeader.js";
import {
  admitElfLoadSegment,
  readElfProgramHeader,
  type ElfProgramHeader,
} from "../elfProgramHeader.js";
import {
  elfStringTableText,
  observeElfStringTableEntry,
} from "../elfStringTable.js";
import { err, ok, type Result } from "../result.js";
import { resolveMappedFileOffset } from "../virtualFileMapping.js";

/** Read up to `length` bytes at `offset`; fewer at the end of the file. */
export type ReadAt = (offset: number, length: number) => Promise<Uint8Array>;

/** Fixed-header identity needed before selecting a library candidate. */
export interface ElfLibraryIdentity {
  readonly machine: number;
  readonly bits: 32 | 64;
  readonly byte_order: "little" | "big";
}

/** A readable identity survives later header or dependency-table admission failures. */
export type ElfDependenciesFailure =
  | {
      readonly kind: "incompatible";
      readonly identity: ElfLibraryIdentity;
      readonly reason: string;
    }
  | {
      readonly kind: "unreadable";
      readonly identity: ElfLibraryIdentity | null;
      readonly reason: string;
    };

/** The same ABI identity is required before dependency tables can select a library. */
export const elfLibraryIdentityMatches = (
  expected: ElfLibraryIdentity,
  observed: ElfLibraryIdentity,
): boolean =>
  expected.machine === observed.machine &&
  expected.bits === observed.bits &&
  expected.byte_order === observed.byte_order;

/** What the dynamic linker needs to load an ELF image's dependencies. */
export interface ElfDependencies extends ElfLibraryIdentity {
  /** Distinct DT_NEEDED sonames in order. */
  readonly needed: readonly string[];
  /** DT_RUNPATH directories as written; undefined without DT_RUNPATH. */
  readonly runpath: readonly string[] | undefined;
  /** DT_RPATH directories as written; empty with DT_RUNPATH, which makes ld.so ignore them. */
  readonly rpath: readonly string[];
}

const PT_LOAD = 1;
const PT_DYNAMIC = 2;
const DT_NEEDED = 1n;
const DT_STRTAB = 5n;
const DT_STRSZ = 10n;
const DT_RPATH = 15n;
const DT_RUNPATH = 29n;

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

const programHeaders = async (
  read: ReadAt,
  header: Buffer,
  size: number,
  bits: 32 | 64,
  policy: DesktopLibraryPolicy,
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
  if (entrySize * count > policy.table_bytes)
    return err(
      desktopLibraryLimit(policy, "table_bytes", "ELF program header table"),
    );
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
    if (parsed.value.type === PT_LOAD) {
      const admitted = admitElfLoadSegment(parsed.value, bits);
      if (!admitted.ok) return err(admitted.error.message);
      if (
        parsed.value.fileSize > 0n &&
        parsed.value.offset + parsed.value.fileSize > BigInt(size)
      )
        return err("ELF load segment is truncated");
    }
    headers.push(parsed.value);
  }
  return ok(headers);
};

/** Distinct DT_NEEDED and search path string offsets, and the string table's address and size. */
const dynamicTags = (
  table: Buffer,
  bits: 32 | 64,
  little: boolean,
  policy: DesktopLibraryPolicy,
): Result<
  {
    readonly needed: ReadonlySet<bigint>;
    readonly runpath: ReadonlySet<bigint>;
    readonly rpath: ReadonlySet<bigint>;
    readonly strtab: bigint | undefined;
    readonly strsz: bigint | undefined;
  },
  string
> => {
  const width = bits === 64 ? 16 : 8;
  const found = {
    needed: new Set<bigint>(),
    runpath: new Set<bigint>(),
    rpath: new Set<bigint>(),
    strtab: undefined as bigint | undefined,
    strsz: undefined as bigint | undefined,
  };
  const lists = new Map([
    [
      DT_NEEDED,
      {
        offsets: found.needed,
        limit: policy.libraries,
        key: "libraries" as const,
      },
    ],
    [
      DT_RUNPATH,
      {
        offsets: found.runpath,
        limit: policy.search_path_entries,
        key: "search_path_entries" as const,
      },
    ],
    [
      DT_RPATH,
      {
        offsets: found.rpath,
        limit: policy.search_path_entries,
        key: "search_path_entries" as const,
      },
    ],
  ]);
  for (let at = 0; at + width <= table.length; at += width) {
    const entry = readElfDynamicEntry(
      table.subarray(at, at + width),
      bits,
      little,
    );
    if (!entry.ok) return err(entry.error.message);
    const { tag, value } = entry.value;
    if (tag === 0n) return ok(found);
    const list = lists.get(tag);
    if (list !== undefined) {
      list.offsets.add(value);
      if (list.offsets.size > list.limit)
        return err(
          desktopLibraryLimit(
            policy,
            list.key,
            `ELF dynamic table ${tag === DT_NEEDED ? "needed libraries" : "search path entries"}`,
          ),
        );
    } else if (tag === DT_STRTAB) found.strtab = value;
    else if (tag === DT_STRSZ) found.strsz = value;
  }
  return err("ELF dynamic table has no DT_NULL terminator");
};

/** The strings at the given offsets of the dynamic string table at file offset `at`, `bytes` long. */
const dynamicStrings = async (
  read: ReadAt,
  file: { readonly size: number; readonly at: bigint; readonly bytes: bigint },
  offsets: ReadonlySet<bigint>,
  policy: DesktopLibraryPolicy,
): Promise<Result<readonly string[], string>> => {
  const values: string[] = [];
  for (const offset of offsets) {
    if (offset >= file.bytes)
      return err("ELF dynamic string lies outside its table");
    const length =
      BigInt(policy.string_bytes) < file.bytes - offset
        ? BigInt(policy.string_bytes)
        : file.bytes - offset;
    const window = await readExactly(read, file.at + offset, length, file.size);
    if (window === undefined) return err("ELF dynamic string is truncated");
    const value = elfStringTableText(
      observeElfStringTableEntry(window, 0, policy.string_bytes),
    );
    if (value === null)
      return err(
        length < file.bytes - offset
          ? desktopLibraryLimit(
              policy,
              "string_bytes",
              "ELF dynamic string read",
            )
          : "ELF dynamic string is truncated",
      );
    values.push(value);
  }
  return ok(values);
};

const directories = (paths: readonly string[]): readonly string[] => [
  ...new Set(
    paths.flatMap((path) => path.split(":")).filter((path) => path.length > 0),
  ),
];

/**
 * The sonames an ELF image needs and the directories its RUNPATH or RPATH
 * names, read from its dynamic segment through the shared ELF readers.
 * A static image has no dependencies.
 */
export const readElfDependencies = async (
  read: ReadAt,
  size: number,
  policy: DesktopLibraryPolicy = desktopLibraryPolicy(),
  expected?: ElfLibraryIdentity,
): Promise<Result<ElfDependencies, ElfDependenciesFailure>> => {
  const header = Buffer.from(await read(0, 64));
  const facts = readElfHeaderFacts(header, size);
  if (!facts.ok)
    return err({ kind: "unreadable", identity: null, reason: facts.error });
  const identity: ElfLibraryIdentity = {
    machine: facts.value.machine,
    bits: facts.value.elfClass,
    byte_order: facts.value.byteOrder,
  };
  if (expected !== undefined && !elfLibraryIdentityMatches(expected, identity))
    return err({
      kind: "incompatible",
      identity,
      reason: `Incompatible ELF library: expected machine ${expected.machine}, ELF${expected.bits}, ${expected.byte_order}-endian; observed machine ${identity.machine}, ELF${identity.bits}, ${identity.byte_order}-endian`,
    });
  const fixed = admitElfFixedHeaderFacts(facts.value, size);
  if (!fixed.ok)
    return err({ kind: "unreadable", identity, reason: fixed.error });
  const dependencies = await readDependencyTables(
    read,
    header,
    size,
    identity,
    policy,
  );
  return dependencies.ok
    ? ok({ ...identity, ...dependencies.value })
    : err({ kind: "unreadable", identity, reason: dependencies.error });
};

/** Parse dependency tables only after their candidate identity has been retained. */
const readDependencyTables = async (
  read: ReadAt,
  header: Buffer,
  size: number,
  identity: ElfLibraryIdentity,
  policy: DesktopLibraryPolicy,
): Promise<
  Result<Pick<ElfDependencies, "needed" | "runpath" | "rpath">, string>
> => {
  const { bits } = identity;
  const little = identity.byte_order === "little";
  const headers = await programHeaders(read, header, size, bits, policy);
  if (!headers.ok) return headers;
  const none = { needed: [], runpath: undefined, rpath: [] };
  const dynamic = headers.value.find((program) => program.type === PT_DYNAMIC);
  if (dynamic === undefined) return ok(none);
  if (dynamic.fileSize > BigInt(policy.table_bytes))
    return err(desktopLibraryLimit(policy, "table_bytes", "ELF dynamic table"));
  const table = await readExactly(read, dynamic.offset, dynamic.fileSize, size);
  if (table === undefined) return err("ELF dynamic table is truncated");
  const tags = dynamicTags(table, bits, little, policy);
  if (!tags.ok) return tags;
  const { strtab, strsz, needed, runpath, rpath } = tags.value;
  if (needed.size + runpath.size + rpath.size === 0) return ok(none);
  if (strtab === undefined || strsz === undefined)
    return err("ELF dynamic string table is not mapped from the file");
  if (strsz > BigInt(size))
    return err("ELF dynamic string table is not mapped from the file");
  const loads = headers.value.filter((program) => program.type === PT_LOAD);
  const stringsAt = resolveMappedFileOffset(
    loads
      .filter((segment) => segment.fileSize > 0n)
      .map((segment) => ({
        address: segment.virtualAddress,
        offset: Number(segment.offset),
        size: Number(segment.fileSize),
      })),
    strtab,
    Number(strsz),
    loads
      .filter((segment) => segment.memorySize > segment.fileSize)
      .map((segment) => ({
        address: segment.virtualAddress + segment.fileSize,
        size: segment.memorySize - segment.fileSize,
      })),
  );
  if (!stringsAt.ok)
    return err(
      stringsAt.error.reason === "ambiguous"
        ? "ELF dynamic string table has ambiguous file mappings"
        : "ELF dynamic string table is not mapped from the file",
    );
  const strings = { size, at: BigInt(stringsAt.value), bytes: strsz };
  const names = await dynamicStrings(read, strings, needed, policy);
  if (!names.ok) return names;
  const search = await dynamicStrings(
    read,
    strings,
    runpath.size > 0 ? runpath : rpath,
    policy,
  );
  if (!search.ok) return search;
  return ok({
    needed: [...new Set(names.value)],
    runpath: runpath.size > 0 ? directories(search.value) : undefined,
    rpath: runpath.size > 0 ? [] : directories(search.value),
  });
};
