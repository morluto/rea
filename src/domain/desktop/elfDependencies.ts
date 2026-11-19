import {
  desktopLibraryLimit,
  desktopLibraryPolicy,
  type DesktopLibraryPolicy,
} from "./libraryPolicy.js";
import {
  DT_NEEDED,
  DT_RPATH,
  DT_RUNPATH,
  DT_STRTAB,
  DT_STRSZ,
  walkElfDynamicTable,
} from "../elfDynamicEntry.js";
import {
  admitElfFixedHeaderFacts,
  readElfHeaderFacts,
} from "../elfFixedHeader.js";
import {
  admitElfLoadSegment,
  elfLoadSpans,
  elfProgramHeaderWidth,
  readElfProgramHeader,
  type ElfProgramHeader,
} from "../elfProgramHeader.js";
import { readElfRawTableDeclarations } from "../elfRawTableDeclarations.js";
import { observeElfStringTableEntry } from "../elfStringTable.js";
import { allKeyed, keyedBy, uniqueKeyed } from "../keyedCollection.js";
import { err, ok, type Result } from "../result.js";
import { decodeStrictUtf8 } from "../strictUtf8.js";
import {
  resolveMappedFileOffset,
  type FileMapping,
  type ZeroFillMapping,
} from "../virtualFileMapping.js";

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
const DEPENDENCY_SINGLETONS = new Set([
  DT_STRTAB,
  DT_STRSZ,
  DT_RPATH,
  DT_RUNPATH,
]);

const readBoundedExtent = async (
  read: ReadAt,
  {
    offset,
    length,
    fileSize,
  }: { offset: bigint; length: bigint; fileSize: number },
  label: string,
  tablePolicy?: DesktopLibraryPolicy,
): Promise<Result<Buffer, string>> => {
  if (offset + length > BigInt(fileSize)) return err(`${label} is truncated`);
  if (tablePolicy !== undefined && length > BigInt(tablePolicy.table_bytes))
    return err(desktopLibraryLimit(tablePolicy, "table_bytes", label));
  const bytes = await read(Number(offset), Number(length));
  return bytes.byteLength === Number(length)
    ? ok(Buffer.from(bytes))
    : err(`${label} is truncated`);
};

const programHeaders = async (
  read: ReadAt,
  header: Buffer,
  size: number,
  { bits, byte_order: byteOrder }: ElfLibraryIdentity,
  policy: DesktopLibraryPolicy,
): Promise<Result<readonly ElfProgramHeader[], string>> => {
  const little = byteOrder === "little";
  const declaration = readElfRawTableDeclarations(header, {
    elfClass: bits,
    byteOrder,
  });
  if (!declaration.ok) return err(declaration.error.message);
  const { offset, width: entrySize, count } = declaration.value.programs;
  if (entrySize < elfProgramHeaderWidth(bits) || count === 0xffff)
    return err("unsupported ELF program header table");
  const table = await readBoundedExtent(
    read,
    { offset, length: BigInt(entrySize * count), fileSize: size },
    "ELF program header table",
    policy,
  );
  if (!table.ok) return table;
  const headers: ElfProgramHeader[] = [];
  for (let index = 0; index < count; index += 1) {
    const parsed = readElfProgramHeader(
      table.value.subarray(index * entrySize, (index + 1) * entrySize),
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
  const walked = walkElfDynamicTable(
    table,
    { bits, littleEndian: little },
    DEPENDENCY_SINGLETONS,
    ({ tag, value }) => {
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
      return undefined;
    },
  );
  if (!walked.ok)
    return err(
      walked.error.kind === "visitor"
        ? walked.error.error
        : `Duplicate dynamic tag 0x${walked.error.tag.toString(16)}`,
    );
  return walked.value.terminatorOffset === null
    ? err("ELF dynamic table has no DT_NULL terminator")
    : ok(found);
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
    const window = await readBoundedExtent(
      read,
      { offset: file.at + offset, length, fileSize: file.size },
      "ELF dynamic string",
    );
    if (!window.ok) return window;
    const observed = observeElfStringTableEntry(
      window.value,
      0,
      policy.string_bytes,
    );
    if (observed.state !== "terminated")
      return err(
        length < file.bytes - offset
          ? desktopLibraryLimit(
              policy,
              "string_bytes",
              "ELF dynamic string read",
            )
          : "ELF dynamic string is truncated",
      );
    // These strings become Node filesystem paths, not byte-preserving display
    // labels. Only admit bytes that UTF-8 string paths can address exactly.
    try {
      values.push(decodeStrictUtf8(observed.bytes, "preserve"));
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      return err(
        "ELF dynamic lookup string is not valid UTF-8; its filesystem identity is unresolved",
      );
    }
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
  const headers = await programHeaders(read, header, size, identity, policy);
  if (!headers.ok) return headers;
  const none = { needed: [], runpath: undefined, rpath: [] };
  // The ELF gABI allows one PT_DYNAMIC; a repeat leaves the table ambiguous.
  const programs = keyedBy(headers.value, ({ type }) => type);
  const dynamicProgram = uniqueKeyed(programs, PT_DYNAMIC);
  if (!dynamicProgram.ok)
    return err(
      `ELF image declares ${String(dynamicProgram.error.ordinals.length)} PT_DYNAMIC program headers`,
    );
  const dynamic = dynamicProgram.value;
  if (dynamic === undefined) return ok(none);
  const table = await readBoundedExtent(
    read,
    { offset: dynamic.offset, length: dynamic.fileSize, fileSize: size },
    "ELF dynamic table",
    policy,
  );
  if (!table.ok) return table;
  const tags = dynamicTags(table.value, bits, little, policy);
  if (!tags.ok) return tags;
  const { strtab, strsz, needed, runpath, rpath } = tags.value;
  if (needed.size + runpath.size + rpath.size === 0) return ok(none);
  if (strtab === undefined || strsz === undefined)
    return err("ELF dynamic string table is not mapped from the file");
  if (strsz > BigInt(size))
    return err("ELF dynamic string table is not mapped from the file");
  const fileBacked: FileMapping[] = [];
  const zeroFills: ZeroFillMapping[] = [];
  for (const load of allKeyed(programs, PT_LOAD)) {
    const span = elfLoadSpans(load);
    if (span.fileBacked !== undefined) fileBacked.push(span.fileBacked);
    if (span.zeroFill !== undefined) zeroFills.push(span.zeroFill);
  }
  const stringsAt = resolveMappedFileOffset(
    fileBacked,
    strtab,
    Number(strsz),
    zeroFills,
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
