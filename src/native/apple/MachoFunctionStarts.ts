import { setImmediate } from "node:timers/promises";

import { LC } from "../../domain/apple/machoLoadCommandCodes.js";
import {
  readMachoHeaderDeclarations,
  readMachoLinkeditDataCommand,
} from "../../domain/apple/machoLoadCommands.js";
import { unrecognizedTarget } from "../../domain/analysisErrorCore.js";
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
  machoDataInCodeKind,
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
/** CPU_TYPE_ARM (<mach/machine.h>). Its function starts tag Thumb code with bit 0. */
const CPU_TYPE_ARM = 12;
/** VM_PROT_EXECUTE (<mach/vm_prot.h>). */
const VM_PROT_EXECUTE = 4;
/** MH_OBJECT (<mach-o/loader.h>): a relocatable object, whose header is not mapped. */
const MH_OBJECT = 1;
const NO_ISSUES: MachoFunctionStart["issues"] = Object.freeze([]) as never;

const hex = (value: bigint): string => `0x${value.toString(16)}`;

/** File range of the __LINKEDIT segment within the selected slice. */
interface LinkeditRange {
  readonly fileOffset: bigint;
  readonly fileSize: bigint;
}

/**
 * Facts about every LC_FUNCTION_STARTS or LC_DATA_IN_CODE command, kept
 * compactly. A malformed image can repeat a command millions of times within
 * the load-command budget, so each one adds two 32-bit words, not an object.
 * The first command is the one decoded; later ones only feed issue counters.
 */
class LinkeditCommandTally {
  count = 0;
  misSized = 0;
  /** Commands too short to hold `dataoff` and `datasize`. */
  fieldless = 0;
  first: { readonly dataOffset: number; readonly dataSize: number } | null =
    null;
  #ranges = new Uint32Array(16);
  #rangeCount = 0;

  add(
    size: number,
    fields: { readonly dataOffset: number; readonly dataSize: number } | null,
  ): void {
    this.count += 1;
    if (size !== LINKEDIT_COMMAND_BYTES) this.misSized += 1;
    if (fields === null) {
      this.fieldless += 1;
      return;
    }
    if (this.count === 1) this.first = fields;
    if (this.#rangeCount * 2 === this.#ranges.length) {
      const grown = new Uint32Array(this.#ranges.length * 2);
      grown.set(this.#ranges);
      this.#ranges = grown;
    }
    this.#ranges[this.#rangeCount * 2] = fields.dataOffset;
    this.#ranges[this.#rangeCount * 2 + 1] = fields.dataSize;
    this.#rangeCount += 1;
  }

  /** Each declared `[dataoff, datasize)` pair, in declaration order. */
  *ranges(): Generator<readonly [number, number]> {
    for (let index = 0; index < this.#rangeCount; index += 1)
      yield [this.#ranges[index * 2]!, this.#ranges[index * 2 + 1]!];
  }
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
  /** The bytes ended after a complete delta, before any zero terminator. */
  readonly unterminated: boolean;
  /** `stopAt` was reached, so `count` is a lower bound. */
  readonly stopped: boolean;
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

/**
 * `linkedit_data_command.dataoff` and `datasize` are `uint32_t`
 * (<mach-o/loader.h>), and so is a FAT32 slice offset, so an end or
 * container offset above this does not name a byte of a 32-bit file.
 */
const UINT32_MAX = 0xffffffff;

/** One command's declared blob, normalized once against the selected slice. */
interface DeclaredBlob {
  readonly dataoff: number;
  readonly datasize: number;
  readonly end: number;
  /** `dataoff + datasize` fits the 32-bit field width. */
  readonly endFits: boolean;
  /** Declared bytes that lie inside the slice. */
  readonly available: number;
}

const declaredBlob = (
  sliceSize: number,
  dataoff: number,
  datasize: number,
): DeclaredBlob => {
  const end = dataoff + datasize;
  return {
    dataoff,
    datasize,
    end,
    endFits: end <= UINT32_MAX,
    available:
      dataoff >= sliceSize ? 0 : Math.min(datasize, sliceSize - dataoff),
  };
};

const insideLinkedit = (
  linkedit: LinkeditRange | undefined,
  blob: DeclaredBlob,
): boolean =>
  linkedit !== undefined &&
  blob.endFits &&
  BigInt(blob.dataoff) >= linkedit.fileOffset &&
  BigInt(blob.end) <= linkedit.fileOffset + linkedit.fileSize;

const blobPastSlice = (sliceSize: number, blob: DeclaredBlob): boolean =>
  !blob.endFits || blob.end > sliceSize;

const readDeclaredBlob = (
  source: ByteSource,
  blob: DeclaredBlob,
): Promise<Buffer> =>
  blob.available === 0
    ? Promise.resolve(Buffer.alloc(0))
    : readByteSourceSlice(source, blob.dataoff, blob.available);

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
  tally: LinkeditCommandTally,
  sliceFileOffset: number,
  linkedit: LinkeditRange | undefined,
  /** Whether this file type places link-edit data in a __LINKEDIT segment. */
  expectsLinkedit: boolean,
): Promise<LoadedTable> => {
  if (tally.count === 0)
    return {
      record: absentCommand,
      misSized: 0,
      duplicate: 0,
      outside: 0,
      pastFile: 0,
      bytes: Buffer.alloc(0),
      declared: 0,
    };
  const first = tally.first;
  const duplicate = tally.count - 1;
  const misSized = tally.misSized;
  let outside = 0;
  let pastFile = 0;
  for (const [dataOffset, dataSize] of tally.ranges()) {
    const blob = declaredBlob(source.size, dataOffset, dataSize);
    if (expectsLinkedit && !insideLinkedit(linkedit, blob)) outside += 1;
    if (blobPastSlice(source.size, blob)) pastFile += 1;
  }
  if (first === null)
    return {
      record: { ...absentCommand, status: "present" },
      misSized,
      duplicate,
      outside,
      pastFile,
      bytes: Buffer.alloc(0),
      declared: 0,
    };
  const blob = declaredBlob(source.size, first.dataOffset, first.dataSize);
  const bytes = await readDeclaredBlob(source, blob);
  // A short read of bytes the slice declares is also a truncated table.
  if (!blobPastSlice(source.size, blob) && bytes.length < blob.available)
    pastFile += 1;
  const container = sliceFileOffset + blob.dataoff;
  return {
    record: {
      status: "present",
      dataoff: blob.dataoff,
      datasize: blob.datasize,
      file_offset: container <= UINT32_MAX ? container : null,
      in_linkedit: insideLinkedit(linkedit, blob),
    },
    misSized,
    duplicate,
    outside,
    pastFile,
    bytes,
    declared: blob.datasize,
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
    /** Stop after this many starts; the caller refuses a larger table. */
    readonly stopAt: number;
  },
  signal: AbortSignal | undefined,
  visit: (start: StartVisit) => void,
): Promise<WalkResult> => {
  const { bytes, textBase, executable, thumbTagged, addressLimit, stopAt } =
    table;
  let terminated = false;
  let stopped = false;
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
      terminated = true;
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
    if (count >= stopAt) {
      stopped = true;
      count += 1;
      break;
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
    unterminated:
      bytes.length > 0 &&
      !terminated &&
      !stopped &&
      !truncated &&
      !overflow &&
      !wrapped &&
      !outOfText,
    stopped,
  };
};

/**
 * The VM address the mach_header is mapped at. ld64 writes each
 * data-in-code offset as an address minus this one, and dyld documents the
 * offset as a delta from the mach_header. A relocatable object does not map
 * its header, so its offsets are addresses (base 0). Otherwise the header is
 * file offset 0, translated through the shared file mappings; an unmapped or
 * ambiguously mapped header leaves the base unknown.
 */
const machHeaderAddress = (
  fileType: number,
  mappings: IntervalIndex<bigint | null>,
): bigint | null => {
  if (fileType === MH_OBJECT) return 0n;
  const delta = lookupInterval(mappings, 0n);
  return delta === undefined || delta === null ? null : delta;
};

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
  headerAddress: bigint | null,
  segments: IntervalIndex<boolean>,
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
    const candidate =
      headerAddress === null ? null : headerAddress + BigInt(offset);
    const vmaddr =
      candidate !== null && lookupInterval(segments, candidate) === true
        ? candidate
        : null;
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
      kind: machoDataInCodeKind(reader.u16(at + 6)),
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

/**
 * A segment the loader maps executable, by its initial protection. The shared
 * reader never makes __PAGEZERO a load region, and neither does this check.
 */
const executableSegment = (segment: MachoSegmentDeclaration): boolean =>
  (segment.protection & VM_PROT_EXECUTE) !== 0 && segment.name !== "__PAGEZERO";

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

/**
 * Refuse a table pair above `max_entries`. `required` is the measured total
 * when both tables were counted, and absent when decoding stopped at the
 * allowance, which only shows the total is larger.
 */
const entryBudgetFailure = (
  maximum: number,
  required: number | undefined,
): BinaryResourceFailure =>
  new BinaryResourceFailure(
    "structure",
    maximum,
    required === undefined
      ? `Mach-O function starts and data-in-code entries exceed max_entries (${String(maximum)})`
      : `Mach-O function starts and data-in-code entries total ${String(required)}, above max_entries (${String(maximum)})`,
    MACHO_FUNCTION_STARTS_ENTRY_LIMIT,
    "entries",
    required,
  );

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
  // The shared header recognizer returns null for a magic that is not
  // Mach-O, such as an ELF or PE file passed without `architecture`. That
  // file is outside this operation, not a malformed Mach-O, so it is reported
  // as unrecognized before the thin reader would call it malformed. A header
  // the recognizer rejects for another reason stays a format failure.
  const header = readMachoHeaderDeclarations(
    await readByteSourceSlice(source, 0, Math.min(32, source.size)),
    source.size,
  );
  if (header.ok && header.value === null)
    throw unrecognizedTarget(
      OPERATION,
      artifact.path,
      "macho",
      "The file is not a thin Mach-O image or a universal Mach-O file.",
    );
  // The shared image walk hands back the two LINKEDIT data commands, so the
  // load-command table is read and framed once.
  const startsCommands = new LinkeditCommandTally();
  const dataCommands = new LinkeditCommandTally();
  const image = await readMachoImageFromReader(
    source,
    input.max_structure_bytes,
    ({ command, size, body, littleEndian: little }: MachoLoadCommandVisit) => {
      const tally =
        command === LC.FUNCTION_STARTS
          ? startsCommands
          : command === LC.DATA_IN_CODE
            ? dataCommands
            : undefined;
      tally?.add(size, readMachoLinkeditDataCommand(command, body, little));
    },
  );
  const littleEndian = image.byte_order === "little";
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
  // A relocatable object has no __LINKEDIT segment: its link-edit data
  // follows the sections outside any segment. `in_linkedit: false` stays an
  // observation there, but only file types that have the segment count a
  // table outside it as a placement issue.
  const expectsLinkedit = image.macho_file_type !== MH_OBJECT;
  const startsTable = await loadTable(
    source,
    startsCommands,
    selected.fileOffset,
    linkedit,
    expectsLinkedit,
  );
  const dataTable = await loadTable(
    source,
    dataCommands,
    selected.fileOffset,
    linkedit,
    expectsLinkedit,
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
  const headerAddress = machHeaderAddress(
    image.macho_file_type,
    indexFileOffsets(image.mappings),
  );
  // ld64 and llvm-objdump take the deltas from the __TEXT vmaddr, and dyld
  // from the mach_header address. Where the header is not mapped at that
  // vmaddr (it lives elsewhere, SG_HIGHVM shifts it, or it is unmapped), the
  // two disagree and the base is reported as disputed.
  const textNotAtHeader =
    missingText === 0 &&
    text !== undefined &&
    startsTable.declared > 0 &&
    headerAddress !== text.address
      ? 1
      : 0;
  const includeStarts = input.kind !== "data";
  const includeData = input.kind !== "starts";
  const sectionIndex = indexSmallestSections(sections);
  // The entry allowance bounds decoding work, not only the result: a data
  // table counted from its bytes is refused before any entry is examined,
  // and the start walk stops once the combined count would exceed it.
  const dataCount = Math.floor(dataTable.bytes.length / DATA_ENTRY_BYTES);
  // With no starts to decode, the data count is the complete need.
  const noStarts = missingText === 1 || startsTable.bytes.length === 0;
  if (dataCount > input.max_entries)
    throw entryBudgetFailure(
      input.max_entries,
      noStarts ? dataCount : undefined,
    );
  // Every entry is checked and counted, but result objects are built only for
  // the requested page of each table.
  const data = await decodeData(
    dataTable.bytes,
    littleEndian,
    headerAddress,
    indexCoveredRanges(
      image.macho_segments
        .filter((segment) => segment.name !== "__PAGEZERO")
        .map((segment) => ({
          address: segment.address,
          size: segment.memory_size,
        })),
    ),
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
          unterminated: false,
          stopped: false,
        }
      : await walkStarts(
          {
            bytes: startsTable.bytes,
            textBase: text?.address ?? 0n,
            executable,
            thumbTagged,
            addressLimit: addressMask(image.bits),
            stopAt: input.max_entries - data.count,
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
  if (decoded.stopped) throw entryBudgetFailure(input.max_entries, undefined);
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
    text_not_at_header: textNotAtHeader,
    unterminated_starts: decoded.unterminated ? 1 : 0,
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
    ...(textNotAtHeader === 1 ? [TEXT.textNotAtHeader] : []),
    ...(decoded.unterminated ? [TEXT.unterminated] : []),
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
