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
import { readLeb128, ULEB64 } from "../../domain/leb128.js";
import {
  MACHO_FUNCTION_STARTS_LIMITATIONS as TEXT,
  machoFunctionStartsHasIssues,
  type InspectMachoFunctionStartsInput,
  type MachoDataInCode,
  type MachoFunctionStart,
  type MachoFunctionStarts,
} from "../../domain/native/machoFunctionStarts.js";
import { lastAtOrBelow } from "../../domain/virtualFileMapping.js";
import {
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
const ADDRESS_MASK = (1n << 64n) - 1n;

const DICE_KIND_NAMES = {
  1: "DICE_KIND_DATA",
  2: "JUMP_TABLE8",
  3: "JUMP_TABLE16",
  4: "JUMP_TABLE32",
  5: "ABS_JUMP_TABLE32",
} as const;

const hex = (value: bigint): string => `0x${value.toString(16)}`;

/** Declared VM range of one executable segment. */
interface ExecutableRange {
  readonly address: bigint;
  readonly memorySize: bigint;
}

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

interface StartFact {
  readonly address: bigint;
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

const containsAddress = (
  start: bigint,
  size: bigint,
  address: bigint,
): boolean => address >= start && address < start + size;

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

const executableAddress = (
  segments: readonly ExecutableRange[],
  address: bigint,
): boolean =>
  segments.some((segment) =>
    containsAddress(segment.address, segment.memorySize, address),
  );

const walkStarts = async (
  bytes: Uint8Array,
  textBase: bigint,
  segments: readonly ExecutableRange[],
  collect: boolean,
  signal: AbortSignal | undefined,
): Promise<WalkResult & { readonly starts: readonly StartFact[] }> => {
  const starts: StartFact[] = [];
  let offset = 0;
  let previous: bigint | null = null;
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
    const base: bigint = previous ?? textBase;
    const sum: bigint = base + read.value;
    const address: bigint = sum & ADDRESS_MASK;
    const didWrap = sum > ADDRESS_MASK;
    const outside = !executableAddress(segments, address);
    const issues: MachoFunctionStart["issues"] = [];
    if (didWrap) {
      wrapped = true;
      issues.push("wrapped");
    }
    if (outside) {
      outOfText = true;
      issues.push("out_of_text");
    }
    count += 1;
    if (collect) starts.push({ address, issues });
    if (didWrap || outside) break;
    previous = address;
  }
  return {
    count,
    truncated,
    overflow,
    wrapped,
    outOfText,
    trailingNonzero,
    starts,
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

/**
 * Addresses `ownerOf` may search. Decoding records a wrapped start and then
 * stops, so that address stays in the list and the list is no longer strictly
 * increasing. The prefix before the wrapped start keeps its original indexes.
 */
const ownerSearchAddresses = (
  starts: readonly {
    readonly vmaddr: bigint;
    readonly issues: MachoFunctionStart["issues"];
  }[],
): readonly bigint[] => {
  const wrappedAt = starts.findIndex((start) =>
    start.issues.includes("wrapped"),
  );
  const prefix = wrappedAt < 0 ? starts : starts.slice(0, wrappedAt);
  return prefix.map((start) => start.vmaddr);
};

/**
 * Greatest start at or before `vmaddr`. `startAddresses` is the strictly
 * increasing prefix from `ownerSearchAddresses`: a wrapped start is omitted.
 * Leaving it in the list makes this binary search return that low address as
 * the owner of later entries.
 */
const ownerOf = (
  startAddresses: readonly bigint[],
  vmaddr: bigint,
): MachoDataInCode["owner"] => {
  const index = lastAtOrBelow(startAddresses, vmaddr);
  return index < 0
    ? null
    : { index, vmaddr: hex(startAddresses[index] as bigint) };
};

const kindOf = (kind: number): MachoDataInCode["kind"] =>
  DICE_KIND_NAMES[kind as keyof typeof DICE_KIND_NAMES] ?? kind;

const decodeData = async (
  bytes: Buffer,
  littleEndian: boolean,
  mappings: IntervalIndex<bigint | null>,
  sections: IntervalIndex<SectionSpan | null>,
  startAddresses: readonly bigint[],
  signal: AbortSignal | undefined,
): Promise<{
  readonly entries: MachoDataInCode[];
  readonly crossings: number;
  readonly unsorted: number;
  readonly unmapped: number;
  readonly zeroLength: number;
}> => {
  const reader = new BinaryReader(bytes, littleEndian, "macho");
  const count = Math.floor(bytes.length / DATA_ENTRY_BYTES);
  const entries: MachoDataInCode[] = [];
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
    const kind = reader.u16(at + 6);
    const vmaddr = fileOffsetAddress(mappings, offset);
    const issues: MachoDataInCode["issues"] = [];
    if (previous !== null && offset <= previous) {
      unsorted += 1;
      issues.push("out_of_order");
    }
    previous = offset;
    if (length === 0) {
      zeroLength += 1;
      issues.push("zero_length");
    }
    let section: string | null = null;
    if (vmaddr === null) {
      unmapped += 1;
      issues.push("unmapped");
    } else {
      const span = smallestSection(sections, vmaddr);
      section = span?.name ?? null;
      const contained =
        length === 0 ||
        (span !== null && vmaddr + BigInt(length) <= span.address + span.size);
      if (!contained) {
        crossings += 1;
        issues.push("crosses_section");
      }
    }
    const owner = vmaddr === null ? null : ownerOf(startAddresses, vmaddr);
    entries.push({
      index,
      offset,
      vmaddr: vmaddr === null ? null : hex(vmaddr),
      length,
      kind: kindOf(kind),
      section,
      owner,
      issues,
    });
  }
  return { entries, crossings, unsorted, unmapped, zeroLength };
};

const pageOf = <Item>(
  items: readonly Item[],
  included: boolean,
  offset: number,
  limit: number,
): readonly Item[] => (included ? items.slice(offset, offset + limit) : []);

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
  const regions = image.load_regions ?? [];
  const segments = keyedBy(regions, (region) => region.macho_segment?.name);
  // Mach-O names one __TEXT and one __LINKEDIT; a repeat keeps the first.
  const linkeditRegion = firstKeyed(
    segments,
    "__LINKEDIT",
    "The first __LINKEDIT segment contains LC_FUNCTION_STARTS and LC_DATA_IN_CODE.",
  );
  const linkedit =
    linkeditRegion === undefined
      ? undefined
      : {
          fileOffset: BigInt(linkeditRegion.mapping.offset),
          fileSize: BigInt(linkeditRegion.mapping.size),
        };
  const text = firstKeyed(
    segments,
    "__TEXT",
    "The first __TEXT segment anchors LC_FUNCTION_STARTS deltas.",
  )?.macho_segment;
  const executable: ExecutableRange[] = regions
    .filter((region) => region.execute)
    .map((region) => ({
      address: region.macho_segment?.address ?? region.mapping.address,
      memorySize: region.memory_size,
    }));
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
  const counted =
    missingText === 1
      ? {
          count: 0,
          truncated: false,
          overflow: false,
          wrapped: false,
          outOfText: false,
          trailingNonzero: false,
          starts: [],
        }
      : await walkStarts(
          startsTable.bytes,
          text?.address ?? 0n,
          executable,
          false,
          signal,
        );
  const dataCount = Math.floor(dataTable.bytes.length / DATA_ENTRY_BYTES);
  requireEntryBudget(counted.count + dataCount, input.max_entries);
  const decoded =
    missingText === 1
      ? counted
      : await walkStarts(
          startsTable.bytes,
          text?.address ?? 0n,
          executable,
          true,
          signal,
        );
  const sectionIndex = indexSmallestSections(sections);
  const startFacts = decoded.starts.map((start, index) => ({
    index,
    vmaddr: start.address,
    issues: start.issues,
  }));
  const data = await decodeData(
    dataTable.bytes,
    littleEndian,
    indexFileOffsets(image.mappings),
    sectionIndex,
    ownerSearchAddresses(startFacts),
    signal,
  );
  const includeStarts = input.kind !== "data";
  const includeData = input.kind !== "starts";
  const startPage = pageOf(
    startFacts,
    includeStarts,
    input.offset,
    input.limit,
  );
  const dataPage = pageOf(data.entries, includeData, input.offset, input.limit);
  const coverage = {
    status: "complete" as const,
    total_starts: startFacts.length,
    total_data_in_code: data.entries.length,
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
      total_starts: startFacts.length,
      next_starts_offset: nextOffset(
        includeStarts,
        input.offset,
        startPage.length,
        startFacts.length,
      ),
      returned_data: dataPage.length,
      total_data: data.entries.length,
      next_data_offset: nextOffset(
        includeData,
        input.offset,
        dataPage.length,
        data.entries.length,
      ),
    },
    starts: startPage.map((start) => ({
      index: start.index,
      vmaddr: hex(start.vmaddr),
      section: smallestSection(sectionIndex, start.vmaddr)?.name ?? null,
      issues: start.issues,
    })),
    data_in_code_entries: [...dataPage],
    limitations,
  };
};
