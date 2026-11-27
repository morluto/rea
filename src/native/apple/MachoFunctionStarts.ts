import { setImmediate } from "node:timers/promises";

import { LC } from "../../domain/apple/machoLoadCommandCodes.js";
import { readMachoLinkeditDataCommand } from "../../domain/apple/machoLoadCommands.js";
import {
  readMachoImageFromReader,
  type MachoLoadCommandVisit,
} from "../../domain/apple/machoImage.js";
import { requireSelectedNativeImageFromReader } from "../../domain/apple/machoSliceSelection.js";
import {
  readByteSourceSlice,
  type ByteSource,
} from "../../domain/byteSource.js";
import {
  BinaryReader,
  BinaryResourceFailure,
} from "../../domain/binaryContainer.js";
import { firstKeyed, keyedBy } from "../../domain/keyedCollection.js";
import type { MachoSegmentDeclaration } from "../../domain/binaryContainer.js";
import { readLeb128, ULEB64 } from "../../domain/leb128.js";
import {
  MACHO_FUNCTION_STARTS_LIMITATIONS as TEXT,
  machoFunctionStartsHasIssues,
  type InspectMachoFunctionStartsInput,
  type MachoDataInCode,
  type MachoFunctionStart,
  type MachoFunctionStarts,
} from "../../domain/native/machoFunctionStarts.js";
import {
  indexCoveredRanges,
  indexFileOffsets,
  indexSmallestSections,
  lookupInterval,
  type IntervalIndex,
  type SectionSpan,
} from "./MachoAddressIndex.js";
import { binaryMetadataArchitecture } from "../../domain/binaryMetadataArchitecture.js";
import {
  assertArtifactReadActive,
  type StableArtifactHandle,
} from "../../resources/index.js";

const OPERATION = "inspect_macho_function_starts";
/** Limit name of the combined entry budget (`max_entries`). */
export const MACHO_FUNCTION_STARTS_ENTRY_LIMIT = "entries";
const LINKEDIT_COMMAND_BYTES = 16;
const DATA_ENTRY_BYTES = 8;
const YIELD_EVERY = 4096;
/** Largest address a 32- or 64-bit image can name; a larger sum wrapped. */
const addressMask = (bits: 32 | 64): bigint => (1n << BigInt(bits)) - 1n;
/** CPU_TYPE_ARM. Its function starts tag Thumb code with bit 0. */
const CPU_TYPE_ARM = 12;
const NO_ISSUES: MachoFunctionStart["issues"] = Object.freeze([]) as never;

const DICE_KIND_NAMES = {
  1: "DICE_KIND_DATA",
  2: "JUMP_TABLE8",
  3: "JUMP_TABLE16",
  4: "JUMP_TABLE32",
  5: "ABS_JUMP_TABLE32",
} as const;

const hex = (value: bigint): string => `0x${value.toString(16)}`;

/** File range of the __LINKEDIT segment within the selected slice. */
interface LinkeditRange {
  readonly fileOffset: bigint;
  readonly fileSize: bigint;
}

interface LinkeditCommand {
  readonly command: number;
  readonly size: number;
  readonly dataOffset: number | null;
  readonly dataSize: number | null;
}

/** One decoded start, handed to a walk visitor without being retained. */
interface StartVisit {
  readonly index: number;
  /** Code address: the accumulated value with any Thumb tag cleared. */
  readonly address: bigint;
  readonly thumb: boolean;
  readonly issues: MachoFunctionStart["issues"];
}

interface WalkResult {
  readonly count: number;
  readonly truncated: boolean;
  readonly overflow: boolean;
  readonly wrapped: boolean;
  readonly outOfText: boolean;
  readonly trailingNonzero: boolean;
}

const absentCommand = {
  status: "absent" as const,
  dataoff: null,
  datasize: null,
  file_offset: null,
  in_linkedit: null,
};

const smallestSection = (
  index: IntervalIndex<SectionSpan | null>,
  address: bigint,
): SectionSpan | null => lookupInterval(index, address) ?? null;

const insideLinkedit = (
  linkedit: LinkeditRange | undefined,
  dataoff: number,
  datasize: number,
): boolean => {
  if (linkedit === undefined) return false;
  if (datasize > 0 && dataoff > 0xffffffff - datasize) return false;
  const start = BigInt(dataoff);
  const end = start + BigInt(datasize);
  return (
    start >= linkedit.fileOffset &&
    end <= linkedit.fileOffset + linkedit.fileSize
  );
};

const blobPastFile = (
  sliceSize: number,
  dataoff: number,
  datasize: number,
): boolean =>
  (datasize > 0 && dataoff > 0xffffffff - datasize) ||
  dataoff > sliceSize ||
  dataoff + datasize > sliceSize;

const readDeclaredBlob = async (
  source: ByteSource,
  dataoff: number,
  datasize: number,
): Promise<Buffer> => {
  if (datasize === 0 || dataoff >= source.size) return Buffer.alloc(0);
  const available = Math.min(datasize, source.size - dataoff);
  const bytes = await readByteSourceSlice(source, dataoff, available);
  return bytes;
};

interface LoadedTable {
  readonly record: MachoFunctionStarts["function_starts"];
  readonly misSized: number;
  readonly duplicate: number;
  readonly outside: number;
  readonly pastFile: number;
  readonly bytes: Buffer;
  readonly declared: number;
}

const loadTable = async (
  source: ByteSource,
  commands: readonly LinkeditCommand[],
  code: number,
  sliceFileOffset: number,
  linkedit: LinkeditRange | undefined,
): Promise<LoadedTable> => {
  const matches = commands.filter((command) => command.command === code);
  if (matches.length === 0)
    return {
      record: absentCommand,
      misSized: 0,
      duplicate: 0,
      outside: 0,
      pastFile: 0,
      bytes: Buffer.alloc(0),
      declared: 0,
    };
  const first = matches[0]!;
  const duplicate = matches.length - 1;
  let misSized = 0;
  let outside = 0;
  let pastFile = 0;
  for (const match of matches) {
    if (match.size !== LINKEDIT_COMMAND_BYTES) misSized += 1;
    if (match.dataOffset === null || match.dataSize === null) continue;
    if (!insideLinkedit(linkedit, match.dataOffset, match.dataSize))
      outside += 1;
    if (blobPastFile(source.size, match.dataOffset, match.dataSize))
      pastFile += 1;
  }
  if (first.dataOffset === null || first.dataSize === null)
    return {
      record: { ...absentCommand, status: "present" },
      misSized,
      duplicate,
      outside,
      pastFile,
      bytes: Buffer.alloc(0),
      declared: 0,
    };
  const { dataOffset, dataSize } = first;
  const declaredPastFile = blobPastFile(source.size, dataOffset, dataSize);
  const bytes = await readDeclaredBlob(source, dataOffset, dataSize);
  const available =
    dataOffset >= source.size
      ? 0
      : Math.min(dataSize, source.size - dataOffset);
  if (!declaredPastFile && bytes.length < available) pastFile += 1;
  const container = sliceFileOffset + dataOffset;
  return {
    record: {
      status: "present",
      dataoff: dataOffset,
      datasize: dataSize,
      file_offset: container <= 0xffffffff ? container : null,
      in_linkedit: insideLinkedit(linkedit, dataOffset, dataSize),
    },
    misSized,
    duplicate,
    outside,
    pastFile,
    bytes,
    declared: dataSize,
  };
};

/**
 * Walk the ULEB128 deltas once. Each delta is added to the previous
 * accumulated value, the first to the __TEXT vmaddr, as ld64 encodes it and
 * llvm-objdump decodes it. On 32-bit ARM, ld64 sets bit 0 for a Thumb start
 * before taking the next delta, so the accumulator keeps that bit and only the
 * reported address clears it, as LLDB does. `visit` sees every start, and
 * the walk retains none, so its memory does not grow with the table.
 */
const walkStarts = async (
  table: {
    readonly bytes: Uint8Array;
    readonly textBase: bigint;
    readonly executable: IntervalIndex<boolean>;
    readonly thumbTagged: boolean;
    readonly addressLimit: bigint;
  },
  signal: AbortSignal | undefined,
  visit: (start: StartVisit) => void,
): Promise<WalkResult> => {
  const { bytes, textBase, executable, thumbTagged, addressLimit } = table;
  let offset = 0;
  let previous: bigint = textBase;
  let count = 0;
  let truncated = false;
  let overflow = false;
  let wrapped = false;
  let outOfText = false;
  let trailingNonzero = false;
  while (offset < bytes.length) {
    if (count > 0 && count % YIELD_EVERY === 0) {
      await setImmediate();
      assertArtifactReadActive(signal);
    }
    const read = readLeb128(bytes, offset, bytes.length, ULEB64);
    if ("failure" in read) {
      truncated = read.failure === "truncated";
      overflow = read.failure === "overflow";
      break;
    }
    offset = read.next;
    if (read.value === 0n) {
      for (let index = offset; index < bytes.length; index += 1) {
        if (bytes[index] !== 0) {
          trailingNonzero = true;
          break;
        }
      }
      break;
    }
    const sum: bigint = previous + read.value;
    const tagged: bigint = sum & addressLimit;
    const thumb = thumbTagged && (tagged & 1n) === 1n;
    const address = thumb ? tagged & ~1n : tagged;
    const didWrap = sum > addressLimit;
    const outside = lookupInterval(executable, address) !== true;
    let issues = NO_ISSUES;
    if (didWrap || outside) {
      issues = [];
      if (didWrap) {
        wrapped = true;
        issues.push("wrapped");
      }
      if (outside) {
        outOfText = true;
        issues.push("out_of_text");
      }
    }
    visit({ index: count, address, thumb, issues });
    count += 1;
    if (didWrap || outside) break;
    previous = tagged;
  }
  return {
    count,
    truncated,
    overflow,
    wrapped,
    outOfText,
    trailingNonzero,
  };
};

/**
 * Map a slice file offset onto the VM address of the shared image's
 * file-backed mappings. Like the shared VM-to-file index, mappings that cover
 * the offset with different translations are ambiguous, so the offset maps to
 * no address instead of the first segment that covers it.
 */
const fileOffsetAddress = (
  index: IntervalIndex<bigint | null>,
  offset: number,
): bigint | null => {
  const delta = lookupInterval(index, BigInt(offset));
  return delta === undefined || delta === null ? null : BigInt(offset) + delta;
};

const kindOf = (kind: number): MachoDataInCode["kind"] =>
  DICE_KIND_NAMES[kind as keyof typeof DICE_KIND_NAMES] ?? kind;

/** A data-in-code entry on the returned page, before its owner is resolved. */
type PagedDataInCode = Omit<MachoDataInCode, "owner"> & {
  readonly address: bigint | null;
};

/**
 * Check every data-in-code entry once, counting its issues, and build result
 * objects only for entries on the requested page.
 */
const decodeData = async (
  bytes: Buffer,
  littleEndian: boolean,
  mappings: IntervalIndex<bigint | null>,
  sections: IntervalIndex<SectionSpan | null>,
  page: { readonly from: number; readonly to: number },
  signal: AbortSignal | undefined,
): Promise<{
  readonly count: number;
  readonly page: readonly PagedDataInCode[];
  readonly crossings: number;
  readonly unsorted: number;
  readonly unmapped: number;
  readonly zeroLength: number;
}> => {
  const reader = new BinaryReader(bytes, littleEndian, "macho");
  const count = Math.floor(bytes.length / DATA_ENTRY_BYTES);
  const entries: PagedDataInCode[] = [];
  let crossings = 0;
  let unsorted = 0;
  let unmapped = 0;
  let zeroLength = 0;
  let previous: number | null = null;
  for (let index = 0; index < count; index += 1) {
    if (index > 0 && index % YIELD_EVERY === 0) {
      await setImmediate();
      assertArtifactReadActive(signal);
    }
    const at = index * DATA_ENTRY_BYTES;
    const offset = reader.u32(at);
    const length = reader.u16(at + 4);
    const vmaddr = fileOffsetAddress(mappings, offset);
    const outOfOrder = previous !== null && offset <= previous;
    previous = offset;
    const span = vmaddr === null ? null : smallestSection(sections, vmaddr);
    const crosses =
      vmaddr !== null &&
      length !== 0 &&
      (span === null || vmaddr + BigInt(length) > span.address + span.size);
    if (outOfOrder) unsorted += 1;
    if (length === 0) zeroLength += 1;
    if (vmaddr === null) unmapped += 1;
    if (crosses) crossings += 1;
    if (index < page.from || index >= page.to) continue;
    const issues: MachoDataInCode["issues"] = [];
    if (outOfOrder) issues.push("out_of_order");
    if (length === 0) issues.push("zero_length");
    if (vmaddr === null) issues.push("unmapped");
    if (crosses) issues.push("crosses_section");
    entries.push({
      index,
      offset,
      vmaddr: vmaddr === null ? null : hex(vmaddr),
      address: vmaddr,
      length,
      kind: kindOf(reader.u16(at + 6)),
      section: span?.name ?? null,
      issues,
    });
  }
  return { count, page: entries, crossings, unsorted, unmapped, zeroLength };
};

/**
 * Resolve each paged entry's owner, the greatest decoded start at or before
 * its address, during the one start walk. Starts increase strictly until a
 * wrapped start ends the walk, and that start is never an owner. Targets are
 * sorted once, so the work is linear in starts plus the page.
 */
class OwnerResolver {
  readonly #targets: { readonly address: bigint; readonly slot: number }[];
  readonly #owners: MachoDataInCode["owner"][];
  #next = 0;
  #best: MachoDataInCode["owner"] = null;

  constructor(entries: readonly PagedDataInCode[]) {
    this.#owners = entries.map(() => null);
    this.#targets = entries
      .flatMap((entry, slot) =>
        entry.address === null ? [] : [{ address: entry.address, slot }],
      )
      .sort((left, right) =>
        left.address < right.address
          ? -1
          : left.address > right.address
            ? 1
            : 0,
      );
  }

  visit(start: StartVisit): void {
    if (start.issues.includes("wrapped")) return;
    while (
      this.#next < this.#targets.length &&
      this.#targets[this.#next]!.address < start.address
    ) {
      this.#owners[this.#targets[this.#next]!.slot] = this.#best;
      this.#next += 1;
    }
    this.#best = { index: start.index, vmaddr: hex(start.address) };
  }

  finish(): readonly MachoDataInCode["owner"][] {
    for (; this.#next < this.#targets.length; this.#next += 1)
      this.#owners[this.#targets[this.#next]!.slot] = this.#best;
    return this.#owners;
  }
}

/** A segment the loader maps executable, by its initial protection. */
const executableSegment = (segment: MachoSegmentDeclaration): boolean =>
  (segment.protection & 4) !== 0 && segment.name !== "__PAGEZERO";

/** Indexes `[from, to)` of one table that the caller's page selects. */
const pageRange = (
  included: boolean,
  offset: number,
  limit: number,
): { readonly from: number; readonly to: number } =>
  included ? { from: offset, to: offset + limit } : { from: 0, to: 0 };

const nextOffset = (
  included: boolean,
  offset: number,
  returned: number,
  total: number,
): number | null =>
  included && offset + returned < total ? offset + returned : null;

const requireEntryBudget = (count: number, maximum: number): void => {
  if (count <= maximum) return;
  throw new BinaryResourceFailure(
    "structure",
    maximum,
    `Mach-O function starts and data-in-code entries total ${String(count)}, above max_entries (${String(maximum)})`,
    MACHO_FUNCTION_STARTS_ENTRY_LIMIT,
    "entries",
    count,
  );
};

/** Decode one selected slice's function starts and data-in-code entries. */
export const parseMachoFunctionStartsFromHandle = async (
  handle: StableArtifactHandle,
  artifact: MachoFunctionStarts["artifact"],
  input: InspectMachoFunctionStartsInput,
  signal?: AbortSignal,
): Promise<MachoFunctionStarts> => {
  assertArtifactReadActive(signal);
  const selected = await requireSelectedNativeImageFromReader(
    OPERATION,
    artifact.path,
    handle,
    input.architecture,
  );
  const source = selected.source;
  // The shared image walk hands back the two LINKEDIT data commands, so the
  // load-command table is read and framed once.
  const visited: MachoLoadCommandVisit[] = [];
  const image = await readMachoImageFromReader(
    source,
    input.max_structure_bytes,
    (command) => {
      if (
        command.command === LC.FUNCTION_STARTS ||
        command.command === LC.DATA_IN_CODE
      )
        visited.push(command);
    },
  );
  const littleEndian = image.byte_order === "little";
  const commands: LinkeditCommand[] = visited.map(({ command, size, body }) => {
    const fields = readMachoLinkeditDataCommand(command, body, littleEndian);
    return {
      command,
      size,
      dataOffset: fields?.dataOffset ?? null,
      dataSize: fields?.dataSize ?? null,
    };
  });
  // Declared segments, file-backed or not: llvm-objdump anchors the deltas on
  // the first __TEXT segment command's vmaddr, which needs no file bytes.
  const segments = keyedBy(image.macho_segments, (segment) => segment.name);
  // Mach-O names one __TEXT and one __LINKEDIT; a repeat keeps the first.
  const linkeditSegment = firstKeyed(
    segments,
    "__LINKEDIT",
    "The first __LINKEDIT segment contains LC_FUNCTION_STARTS and LC_DATA_IN_CODE.",
  );
  const linkedit =
    linkeditSegment === undefined
      ? undefined
      : {
          fileOffset: linkeditSegment.file_offset,
          fileSize: linkeditSegment.file_size,
        };
  const text = firstKeyed(
    segments,
    "__TEXT",
    "The first __TEXT segment anchors LC_FUNCTION_STARTS deltas.",
  );
  const executable = indexCoveredRanges(
    image.macho_segments.filter(executableSegment).map((segment) => ({
      address: segment.address,
      size: segment.memory_size,
    })),
  );
  const startsTable = await loadTable(
    source,
    commands,
    LC.FUNCTION_STARTS,
    selected.fileOffset,
    linkedit,
  );
  const dataTable = await loadTable(
    source,
    commands,
    LC.DATA_IN_CODE,
    selected.fileOffset,
    linkedit,
  );
  const sections: SectionSpan[] = [];
  for (const section of image.sections) {
    if (section.format !== "macho") continue;
    sections.push({
      name: section.section_name,
      address: section.address,
      size: section.declared_range.size,
    });
  }
  const missingText =
    startsTable.record.status === "present" &&
    startsTable.declared > 0 &&
    text === undefined
      ? 1
      : 0;
  const includeStarts = input.kind !== "data";
  const includeData = input.kind !== "starts";
  const sectionIndex = indexSmallestSections(sections);
  // Every entry is checked and counted, but result objects are built only for
  // the requested page of each table.
  const data = await decodeData(
    dataTable.bytes,
    littleEndian,
    indexFileOffsets(image.mappings),
    sectionIndex,
    pageRange(includeData, input.offset, input.limit),
    signal,
  );
  const startRange = pageRange(includeStarts, input.offset, input.limit);
  const startPage: MachoFunctionStart[] = [];
  const owners = new OwnerResolver(data.page);
  const thumbTagged = image.macho_cpu_type === CPU_TYPE_ARM;
  const decoded =
    missingText === 1
      ? {
          count: 0,
          truncated: false,
          overflow: false,
          wrapped: false,
          outOfText: false,
          trailingNonzero: false,
        }
      : await walkStarts(
          {
            bytes: startsTable.bytes,
            textBase: text?.address ?? 0n,
            executable,
            thumbTagged,
            addressLimit: addressMask(image.bits),
          },
          signal,
          (start) => {
            owners.visit(start);
            if (start.index < startRange.from || start.index >= startRange.to)
              return;
            startPage.push({
              index: start.index,
              vmaddr: hex(start.address),
              ...(thumbTagged ? { thumb: start.thumb } : {}),
              section:
                smallestSection(sectionIndex, start.address)?.name ?? null,
              issues: [...start.issues],
            });
          },
        );
  requireEntryBudget(decoded.count + data.count, input.max_entries);
  const resolvedOwners = owners.finish();
  const dataPage: MachoDataInCode[] = data.page.map(
    ({ address: _address, ...entry }, slot) => ({
      ...entry,
      owner: resolvedOwners[slot] ?? null,
    }),
  );
  const coverage = {
    status: "complete" as const,
    total_starts: decoded.count,
    total_data_in_code: data.count,
    duplicate_commands: startsTable.duplicate + dataTable.duplicate,
    mis_sized_commands: startsTable.misSized + dataTable.misSized,
    outside_linkedit: startsTable.outside + dataTable.outside,
    truncated_commands: startsTable.pastFile + dataTable.pastFile,
    uleb_truncated: decoded.truncated ? 1 : 0,
    uleb_overflow: decoded.overflow ? 1 : 0,
    non_monotonic: decoded.wrapped ? 1 : 0,
    out_of_text: decoded.outOfText ? 1 : 0,
    missing_text_anchor: missingText,
    trailing_nonzero: decoded.trailingNonzero ? 1 : 0,
    data_trailing_bytes: dataTable.bytes.length % DATA_ENTRY_BYTES,
    section_crossings: data.crossings,
    unsorted_data: data.unsorted,
    unmapped_data: data.unmapped,
    zero_length_data: data.zeroLength,
  };
  const partial = machoFunctionStartsHasIssues(coverage);
  const limitations = [
    TEXT.missingStarts,
    TEXT.missingData,
    TEXT.static,
    ...(startsTable.duplicate > 0 ? [TEXT.duplicateStarts] : []),
    ...(dataTable.duplicate > 0 ? [TEXT.duplicateData] : []),
    ...(startsTable.outside > 0 ? [TEXT.outsideStarts] : []),
    ...(dataTable.outside > 0 ? [TEXT.outsideData] : []),
    ...(startsTable.misSized > 0 ? [TEXT.misSizedStarts] : []),
    ...(dataTable.misSized > 0 ? [TEXT.misSizedData] : []),
    ...(decoded.truncated ? [TEXT.ulebTruncated] : []),
    ...(decoded.overflow ? [TEXT.ulebOverflow] : []),
    ...(decoded.wrapped ? [TEXT.wrapped] : []),
    ...(decoded.outOfText ? [TEXT.outOfText] : []),
    ...(missingText === 1 ? [TEXT.missingText] : []),
    ...(decoded.trailingNonzero ? [TEXT.trailing] : []),
    ...(startsTable.pastFile > 0 ? [TEXT.startsPastFile] : []),
    ...(dataTable.pastFile > 0 ? [TEXT.dataPastFile] : []),
    ...(coverage.data_trailing_bytes > 0 ? [TEXT.dataTrailing] : []),
    ...(data.crossings > 0 ? [TEXT.crosses] : []),
    ...(data.unsorted > 0 ? [TEXT.unsorted] : []),
    ...(data.zeroLength > 0 ? [TEXT.zeroLength] : []),
    ...(data.unmapped > 0 ? [TEXT.unmapped] : []),
    ...selected.limitations,
  ];
  const architecture = binaryMetadataArchitecture(image.architecture) ?? null;
  return {
    artifact,
    format: "macho",
    architecture,
    bits: image.bits,
    byte_order: image.byte_order,
    ...(selected.selection === null
      ? {}
      : { selected_slice: selected.selection }),
    function_starts: startsTable.record,
    data_in_code: dataTable.record,
    coverage: { ...coverage, status: partial ? "partial" : "complete" },
    page: {
      kind: input.kind,
      offset: input.offset,
      limit: input.limit,
      returned_starts: startPage.length,
      total_starts: decoded.count,
      next_starts_offset: nextOffset(
        includeStarts,
        input.offset,
        startPage.length,
        decoded.count,
      ),
      returned_data: dataPage.length,
      total_data: data.count,
      next_data_offset: nextOffset(
        includeData,
        input.offset,
        dataPage.length,
        data.count,
      ),
    },
    starts: startPage,
    data_in_code_entries: dataPage,
    limitations,
  };
};
