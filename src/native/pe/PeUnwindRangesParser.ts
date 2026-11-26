import { setImmediate } from "node:timers/promises";

import {
  assertArtifactReadActive,
  type StableArtifactHandle,
} from "../../resources/index.js";
import {
  BinaryFormatFailure,
  BinaryReader,
  BinaryResourceFailure,
  createFileMappingIndex,
  type FileMappingIndex,
} from "../../domain/binaryContainer.js";
import {
  peDeclaredFileMappings,
  readPeImageFromReader,
  type PeImage,
} from "../../domain/native/peImage.js";
import { peSectionVirtualExtent } from "../../domain/peSectionHeader.js";
import {
  MAX_PE_UNWIND_CHAIN_DEPTH,
  PE_UNWIND_LIMITATIONS,
  PE_X64_RUNTIME_FUNCTION_BYTES as ENTRY_BYTES,
  type InspectPeUnwindRangesInput,
  type PeUnwindEntry,
  type PeUnwindRanges,
} from "../../domain/native/peUnwindRanges.js";

/** IMAGE_DIRECTORY_ENTRY_EXCEPTION. */
const EXCEPTION_DIRECTORY = 3;
const IMAGE_FILE_MACHINE_AMD64 = 0x8664;
/** UNW_FLAG_EHANDLER, UNW_FLAG_UHANDLER and UNW_FLAG_CHAININFO (x64 UNWIND_INFO). */
const UNW_FLAG_EHANDLER = 0x1;
const UNW_FLAG_UHANDLER = 0x2;
const UNW_FLAG_CHAININFO = 0x4;
/** winnt.h RUNTIME_FUNCTION_INDIRECT: the unwind RVA names another RUNTIME_FUNCTION. */
const RUNTIME_FUNCTION_INDIRECT = 0x1;
/** UNWIND_INFO header: version/flags, prolog size, code count, frame register. */
const UNWIND_HEADER_BYTES = 4;
/** Limit name of the exception-directory entry budget (`max_entries`). */
export const PE_UNWIND_ENTRY_LIMIT = "entries";
const READ_WINDOW_BYTES = 65536;
const YIELD_EVERY = 4096;

const KIND_PRIMARY = 0;
const KIND_CHAINED = 1;
const KIND_UNKNOWN = 2;
const KINDS = ["primary", "chained", "unknown"] as const;

const ISSUES = [
  "empty_range",
  "unsorted",
  "overlaps_previous",
  "unwind_unmapped",
  "unwind_version_unknown",
  "unwind_codes_unmapped",
  "chain_parent_missing",
  "chain_parent_mismatch",
  "chain_cycle",
] as const satisfies readonly PeUnwindEntry["issues"][number][];
const issueBit = (issue: (typeof ISSUES)[number]): number =>
  1 << ISSUES.indexOf(issue);

const hex = (value: number | bigint): string => `0x${value.toString(16)}`;

/** Bounded windowed reads, so per-entry unwind headers do not issue one read each. */
const windowedReader = (handle: StableArtifactHandle) => {
  let windowStart = -1;
  let window: Buffer = Buffer.alloc(0);
  return async (offset: number, length: number): Promise<Buffer | null> => {
    if (offset < 0 || offset + length > handle.size) return null;
    if (
      windowStart < 0 ||
      offset < windowStart ||
      offset + length > windowStart + window.length
    ) {
      windowStart = offset;
      window = await handle.readRange(
        offset,
        Math.min(Math.max(READ_WINDOW_BYTES, length), handle.size - offset),
      );
    }
    return window.subarray(offset - windowStart, offset - windowStart + length);
  };
};

const sectionNameAt = (image: PeImage, rva: number): string | null => {
  for (const section of image.sections) {
    const span = peSectionVirtualExtent(section.virtual_size, section.raw_size);
    if (rva >= section.virtual_address && rva < section.virtual_address + span)
      return section.name;
  }
  return null;
};

/** Decoded table state, kept in typed arrays sized by the declared entry count. */
interface Table {
  readonly count: number;
  readonly begin: Uint32Array;
  readonly end: Uint32Array;
  readonly unwind: Uint32Array;
  readonly kind: Uint8Array;
  readonly version: Int8Array;
  readonly flags: Int8Array;
  readonly codes: Int16Array;
  readonly hasParent: Uint8Array;
  readonly parentBegin: Uint32Array;
  readonly parentEnd: Uint32Array;
  readonly parentUnwind: Uint32Array;
  readonly parentIndex: Int32Array;
  readonly primary: Int32Array;
  readonly issues: Uint16Array;
}

const allocateTable = (count: number): Table => ({
  count,
  begin: new Uint32Array(count),
  end: new Uint32Array(count),
  unwind: new Uint32Array(count),
  kind: new Uint8Array(count),
  version: new Int8Array(count).fill(-1),
  flags: new Int8Array(count).fill(-1),
  codes: new Int16Array(count).fill(-1),
  hasParent: new Uint8Array(count),
  parentBegin: new Uint32Array(count),
  parentEnd: new Uint32Array(count),
  parentUnwind: new Uint32Array(count),
  parentIndex: new Int32Array(count).fill(-1),
  primary: new Int32Array(count).fill(-1),
  issues: new Uint16Array(count),
});

/** Read one entry's UNWIND_INFO, or the RUNTIME_FUNCTION an indirect RVA names. */
interface UnwindContext {
  readonly table: Table;
  readonly base: bigint;
  readonly lookup: FileMappingIndex;
  readonly read: ReturnType<typeof windowedReader>;
}

const decodeUnwind = async (
  { table, base, lookup, read }: UnwindContext,
  index: number,
): Promise<void> => {
  const rva = table.unwind[index]!;
  const fileOffset = (target: number, bytes: number): number | undefined =>
    lookup.tryOffset(base + BigInt(target), bytes);
  const setParent = (bytes: Buffer): void => {
    const record = new BinaryReader(bytes, true, "pe");
    table.hasParent[index] = 1;
    table.parentBegin[index] = record.u32(0);
    table.parentEnd[index] = record.u32(4);
    table.parentUnwind[index] = record.u32(8);
  };
  const unmapped = (): void => {
    table.kind[index] = KIND_UNKNOWN;
    table.issues[index]! |= issueBit("unwind_unmapped");
  };
  if ((rva & RUNTIME_FUNCTION_INDIRECT) !== 0) {
    // `>>> 0` keeps RVAs at or above 0x80000000 unsigned.
    const target = (rva & ~RUNTIME_FUNCTION_INDIRECT) >>> 0;
    const offset = fileOffset(target, ENTRY_BYTES);
    const bytes = offset === undefined ? null : await read(offset, ENTRY_BYTES);
    if (bytes === null) return unmapped();
    table.kind[index] = KIND_CHAINED;
    setParent(bytes);
    return;
  }
  const offset = fileOffset(rva, UNWIND_HEADER_BYTES);
  const header =
    offset === undefined ? null : await read(offset, UNWIND_HEADER_BYTES);
  if (offset === undefined || header === null) return unmapped();
  const fields = new BinaryReader(header, true, "pe");
  const version = fields.u8(0) & 0x7;
  const flags = fields.u8(0) >> 3;
  const codes = fields.u8(2);
  table.version[index] = version;
  table.flags[index] = flags;
  table.codes[index] = codes;
  if (version !== 1 && version !== 2) {
    table.kind[index] = KIND_UNKNOWN;
    table.issues[index]! |= issueBit("unwind_version_unknown");
    return;
  }
  // The declared code array must be file-backed too, though it is not evaluated.
  const chained = UNWIND_HEADER_BYTES + 2 * ((codes + 1) & ~1);
  if (fileOffset(rva, chained) === undefined) {
    table.kind[index] = KIND_UNKNOWN;
    table.issues[index]! |= issueBit("unwind_codes_unmapped");
    return;
  }
  if ((flags & UNW_FLAG_CHAININFO) === 0) {
    table.kind[index] = KIND_PRIMARY;
    return;
  }
  // The chained RUNTIME_FUNCTION follows the code array, padded to an even count.
  const parentOffset = fileOffset(rva + chained, ENTRY_BYTES);
  const parent =
    parentOffset === undefined ? null : await read(parentOffset, ENTRY_BYTES);
  if (parent === null) return unmapped();
  table.kind[index] = KIND_CHAINED;
  setParent(parent);
};

/**
 * Entry indices ordered by the whole record (begin, end, unwind RVA), then
 * index. Sorted once, so every parent lookup is a search, even when many
 * entries share a begin RVA.
 */
const recordOrder = (table: Table): Uint32Array => {
  const order = new Uint32Array(table.count);
  for (let index = 0; index < table.count; index++) order[index] = index;
  order.sort(
    (left, right) =>
      table.begin[left]! - table.begin[right]! ||
      table.end[left]! - table.end[right]! ||
      table.unwind[left]! - table.unwind[right]! ||
      left - right,
  );
  return order;
};

/** First position whose record is not below (begin, end, unwind). */
const lowerBound = (
  table: Table,
  order: Uint32Array,
  { begin, end, unwind }: { begin: number; end: number; unwind: number },
): number => {
  let low = 0;
  let high = table.count;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const at = order[middle]!;
    const below =
      table.begin[at]! < begin ||
      (table.begin[at] === begin &&
        (table.end[at]! < end ||
          (table.end[at] === end && table.unwind[at]! < unwind)));
    if (below) low = middle + 1;
    else high = middle;
  }
  return low;
};

/**
 * Lowest index of the entry that is exactly the named RUNTIME_FUNCTION
 * (begin, end and unwind RVAs). -2 when entries share its begin RVA but none
 * matches the whole record; -1 when no entry begins there.
 */
const indexOfRecord = (
  table: Table,
  order: Uint32Array,
  index: number,
): number => {
  const begin = table.parentBegin[index]!;
  const end = table.parentEnd[index]!;
  const unwind = table.parentUnwind[index]!;
  const exact = lowerBound(table, order, { begin, end, unwind });
  const candidate = order[exact];
  if (
    candidate !== undefined &&
    table.begin[candidate] === begin &&
    table.end[candidate] === end &&
    table.unwind[candidate] === unwind
  )
    return candidate;
  const first = order[lowerBound(table, order, { begin, end: 0, unwind: 0 })];
  return first !== undefined && table.begin[first] === begin ? -2 : -1;
};

/** Follow one chain to the primary entry it extends, within the depth bound. */
const resolveChain = (table: Table, index: number): void => {
  let current = index;
  let depth = 0;
  while (table.kind[current] === KIND_CHAINED) {
    const next = table.parentIndex[current]!;
    if (next < 0) {
      // A mismatched parent is already named; any other unresolved link is missing.
      if (
        current !== index ||
        (table.issues[index]! & issueBit("chain_parent_mismatch")) === 0
      )
        table.issues[index]! |= issueBit("chain_parent_missing");
      return;
    }
    if (++depth > MAX_PE_UNWIND_CHAIN_DEPTH) {
      table.issues[index]! |= issueBit("chain_cycle");
      return;
    }
    current = next;
  }
  if (table.kind[current] === KIND_PRIMARY) table.primary[index] = current;
};

/** Link every chained entry to its parent and primary entry; yields to cancellation. */
const resolveChains = async (
  table: Table,
  signal: AbortSignal | undefined,
): Promise<void> => {
  const order = recordOrder(table);
  for (let index = 0; index < table.count; index++) {
    if (index % YIELD_EVERY === 0 && index > 0) {
      await setImmediate();
      assertArtifactReadActive(signal);
    }
    if (table.hasParent[index] !== 1) continue;
    const parent = indexOfRecord(table, order, index);
    if (parent === -2)
      table.issues[index]! |= issueBit("chain_parent_mismatch");
    table.parentIndex[index] = Math.max(parent, -1);
  }
  for (let index = 0; index < table.count; index++) {
    if (index % YIELD_EVERY === 0 && index > 0) {
      await setImmediate();
      assertArtifactReadActive(signal);
    }
    const kind = table.kind[index]!;
    if (kind === KIND_PRIMARY) table.primary[index] = index;
    else if (kind === KIND_CHAINED) resolveChain(table, index);
  }
};

const flagNames = (flags: number): PeUnwindEntry["unwind_flags"] =>
  flags < 0
    ? null
    : [
        ...((flags & UNW_FLAG_EHANDLER) !== 0 ? (["ehandler"] as const) : []),
        ...((flags & UNW_FLAG_UHANDLER) !== 0 ? (["uhandler"] as const) : []),
        ...((flags & UNW_FLAG_CHAININFO) !== 0 ? (["chaininfo"] as const) : []),
      ];

const entryAt = (table: Table, index: number): PeUnwindEntry => {
  const parentIndex = table.parentIndex[index]!;
  const primary = table.primary[index]!;
  const version = table.version[index]!;
  const codes = table.codes[index]!;
  return {
    index,
    begin_rva: hex(table.begin[index]!),
    end_rva: hex(table.end[index]!),
    unwind_rva: hex(table.unwind[index]!),
    kind: KINDS[table.kind[index]!]!,
    unwind_version: version < 0 ? null : version,
    unwind_flags: flagNames(table.flags[index]!),
    unwind_code_count: codes < 0 ? null : codes,
    parent:
      table.hasParent[index] === 1
        ? {
            begin_rva: hex(table.parentBegin[index]!),
            end_rva: hex(table.parentEnd[index]!),
            unwind_rva: hex(table.parentUnwind[index]!),
            index: parentIndex < 0 ? null : parentIndex,
          }
        : null,
    primary_index: primary < 0 ? null : primary,
    issues: ISSUES.filter(
      (issue) => (table.issues[index]! & issueBit(issue)) !== 0,
    ),
  };
};

const selected = (
  table: Table,
  index: number,
  kind: InspectPeUnwindRangesInput["kind"],
): boolean =>
  kind === "all" ||
  (kind === "issues"
    ? table.issues[index] !== 0
    : table.kind[index] === (kind === "primary" ? KIND_PRIMARY : KIND_CHAINED));

const emptyReport = (
  image: PeImage,
  artifact: PeUnwindRanges["artifact"],
  input: InspectPeUnwindRangesInput,
  status: "absent" | "unsupported_machine",
): PeUnwindRanges => ({
  artifact,
  format: image.bits === 64 ? "pe32-plus" : "pe32",
  machine: image.pe_machine,
  image_base: hex(image.image_base),
  address_space: "rva",
  exception_directory: {
    status,
    rva: null,
    size: null,
    file_offset: null,
    section: null,
  },
  coverage: {
    status: status === "absent" ? "complete" : "partial",
    total_entries: 0,
    primary_entries: 0,
    chained_entries: 0,
    unknown_entries: 0,
    entries_with_issues: 0,
    trailing_bytes: 0,
  },
  page: {
    kind: input.kind,
    offset: input.offset,
    limit: input.limit,
    returned: 0,
    total: 0,
    next_offset: null,
  },
  entries: [],
  limitations: [
    status === "absent"
      ? PE_UNWIND_LIMITATIONS.absent
      : PE_UNWIND_LIMITATIONS.machine,
  ],
});

/** Read every entry's bounds and unwind data. */
const decodeEntries = async (
  context: UnwindContext,
  bytes: Buffer,
  signal: AbortSignal | undefined,
): Promise<void> => {
  const { table } = context;
  const reader = new BinaryReader(bytes, true, "pe");
  for (let index = 0; index < table.count; index++) {
    if (index % YIELD_EVERY === 0 && index > 0) {
      await setImmediate();
      assertArtifactReadActive(signal);
    }
    const at = index * ENTRY_BYTES;
    const begin = reader.u32(at);
    const end = reader.u32(at + 4);
    table.begin[index] = begin;
    table.end[index] = end;
    table.unwind[index] = reader.u32(at + 8);
    if (end <= begin) table.issues[index]! |= issueBit("empty_range");
    if (index > 0) {
      const previousBegin = table.begin[index - 1]!;
      if (begin < previousBegin) {
        table.issues[index]! |= issueBit("unsorted");
      }
      // Order and intersection are separate facts: an unsorted entry can overlap too.
      if (begin < table.end[index - 1]! && end > previousBegin)
        table.issues[index]! |= issueBit("overlaps_previous");
    }
  }
  // Visit unwind data in ascending RVA order, so the windowed reader moves
  // forward and reads each file region about once, whatever the table order.
  const order = new Uint32Array(table.count);
  for (let index = 0; index < table.count; index++) order[index] = index;
  const target = (index: number): number =>
    (table.unwind[index]! & ~RUNTIME_FUNCTION_INDIRECT) >>> 0;
  order.sort((left, right) => target(left) - target(right) || left - right);
  for (let position = 0; position < table.count; position++) {
    if (position % YIELD_EVERY === 0 && position > 0) {
      await setImmediate();
      assertArtifactReadActive(signal);
    }
    await decodeUnwind(context, order[position]!);
  }
};

/** Counts over every entry, and the selected page. */
const countAndPage = (table: Table, input: InspectPeUnwindRangesInput) => {
  let primary = 0;
  let chained = 0;
  let unknown = 0;
  let withIssues = 0;
  let total = 0;
  const entries: PeUnwindEntry[] = [];
  for (let index = 0; index < table.count; index++) {
    const kind = table.kind[index]!;
    if (kind === KIND_PRIMARY) primary++;
    else if (kind === KIND_CHAINED) chained++;
    else unknown++;
    if (table.issues[index] !== 0) withIssues++;
    if (!selected(table, index, input.kind)) continue;
    if (total >= input.offset && entries.length < input.limit)
      entries.push(entryAt(table, index));
    total++;
  }
  return { primary, chained, unknown, withIssues, total, entries };
};

/** Decode the x64 exception directory of one identity-checked PE image. */
export const parsePeUnwindRangesFromHandle = async (
  handle: StableArtifactHandle,
  artifact: PeUnwindRanges["artifact"],
  input: InspectPeUnwindRangesInput,
  signal?: AbortSignal,
): Promise<PeUnwindRanges> => {
  assertArtifactReadActive(signal);
  const image = await readPeImageFromReader(handle);
  const directory = image.pe_data_directories[EXCEPTION_DIRECTORY];
  if (
    directory === undefined ||
    (directory.address === 0 && directory.size === 0)
  )
    return emptyReport(image, artifact, input, "absent");
  if (image.pe_machine !== IMAGE_FILE_MACHINE_AMD64)
    return emptyReport(image, artifact, input, "unsupported_machine");
  if (directory.address === 0 || directory.size === 0)
    throw new BinaryFormatFailure(
      "malformed",
      "PE exception directory declares a zero RVA or size while the other field is nonzero",
      { format: "pe" },
    );
  const base = image.image_base;
  const lookup = createFileMappingIndex(
    peDeclaredFileMappings(image),
    image.zero_fills,
  );
  // The whole declared directory, trailing bytes included, must be file-backed.
  const directoryOffset = lookup.tryOffset(
    base + BigInt(directory.address),
    directory.size,
  );
  if (directoryOffset === undefined)
    throw new BinaryFormatFailure(
      "malformed",
      `PE exception directory at RVA ${hex(directory.address)} (${String(directory.size)} bytes) is not backed by file bytes`,
      { format: "pe" },
    );
  // Only a file-backed directory reaches the decoding allowance, so a
  // directory that leaves the file stays a malformed target.
  const count = Math.floor(directory.size / ENTRY_BYTES);
  // The declared entry count is the complete need.
  if (count > input.max_entries)
    throw new BinaryResourceFailure(
      "structure",
      input.max_entries,
      `PE exception directory declares ${String(count)} entries, above max_entries (${String(input.max_entries)})`,
      PE_UNWIND_ENTRY_LIMIT,
      "entries",
      count,
    );
  const tableBytes = count * ENTRY_BYTES;
  const bytes =
    tableBytes === 0
      ? Buffer.alloc(0)
      : await handle.readRange(directoryOffset, tableBytes);
  const table = allocateTable(count);
  const context: UnwindContext = {
    table,
    base,
    lookup,
    read: windowedReader(handle),
  };
  await decodeEntries(context, bytes, signal);
  assertArtifactReadActive(signal);
  await resolveChains(table, signal);
  const { primary, chained, unknown, withIssues, total, entries } =
    countAndPage(table, input);
  const trailingBytes = directory.size % ENTRY_BYTES;
  const end = input.offset + entries.length;
  return {
    artifact,
    format: image.bits === 64 ? "pe32-plus" : "pe32",
    machine: image.pe_machine,
    image_base: hex(base),
    address_space: "rva",
    exception_directory: {
      status: "present",
      rva: hex(directory.address),
      size: directory.size,
      file_offset: directoryOffset,
      section: sectionNameAt(image, directory.address),
    },
    coverage: {
      status: unknown === 0 && trailingBytes === 0 ? "complete" : "partial",
      total_entries: count,
      primary_entries: primary,
      chained_entries: chained,
      unknown_entries: unknown,
      entries_with_issues: withIssues,
      trailing_bytes: trailingBytes,
    },
    page: {
      kind: input.kind,
      offset: input.offset,
      limit: input.limit,
      returned: entries.length,
      total,
      next_offset: end < total ? end : null,
    },
    entries,
    limitations: [
      PE_UNWIND_LIMITATIONS.codes,
      PE_UNWIND_LIMITATIONS.leaf,
      ...(trailingBytes === 0 ? [] : [PE_UNWIND_LIMITATIONS.trailing]),
    ],
  };
};
