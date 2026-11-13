import {
  hashArtifactRange,
  readArtifactRange as readExact,
} from "../ArtifactCarrierRange.js";
import type { FileHandle } from "node:fs/promises";

import {
  isMachoZeroFillSection,
  readMachoSectionHeader,
} from "../../domain/apple/machoSectionHeader.js";
import {
  admitMachoSegmentCommand,
  readMachoSegmentHeader,
} from "../../domain/apple/machoSegmentHeader.js";
import {
  readFatHeaderPrefix,
  readMachoHeaderPrefixFacts,
  validateFatSliceIdentity,
  type FatSliceDeclaration,
} from "../../domain/apple/machoContainer.js";
import { readElfSectionHeader } from "../../domain/elfSectionHeader.js";
import { readElfProgramHeader } from "../../domain/elfProgramHeader.js";
import { readElfRawTableDeclarations } from "../../domain/elfRawTableDeclarations.js";
import { readElfFixedHeader } from "../../domain/elfFixedHeader.js";
import { MAX_INSPECT_ELF_NOTE_ENTRIES } from "../../domain/native/elfNotes.js";
import {
  elfNoteAlignment,
  elfNoteLayout,
  readElfNoteHeader,
} from "../../domain/native/elfNoteLayout.js";
import {
  MAX_INSPECT_PE_DIRECTORY_ENTRIES,
  MAX_INSPECT_PE_FILE_BYTES,
} from "../../domain/native/peResources.js";
import {
  frameLoadCommands,
  readMachoContainer,
  readSliceCommandTable,
  type ReadAt,
} from "../apple/MachoLoadCommandReader.js";
import { abortIfNeeded } from "../ArtifactHash.js";
import { ArtifactReaderFailure } from "../ArtifactReader.js";
import { locatePeResourcePayloads } from "../../native/pe/PeResourceLayout.js";
import { DENO_SECTION_MAGIC } from "./DenoSectionLayout.js";

const LC_SEGMENT = 0x1;
const LC_SEGMENT_64 = 0x19;
const CPU_TYPE_ARM64 = 0x0100000c;
const PT_NOTE = 4;
const PN_XNUM = 0xffff;
const ELF64_PROGRAM_HEADER_BYTES = 56;
const ELF32_PROGRAM_HEADER_BYTES = 32;
const ELF64_SECTION_HEADER_BYTES = 64;
const ELF32_SECTION_HEADER_BYTES = 40;
const SHT_NOTE = 7;
const RT_RCDATA = 10;
const RESOURCE_NAME = "D3N0L4ND";
const SECTION_NAME = "d3n0l4nd";
const SECTION_NAME_BYTES = Buffer.from(SECTION_NAME, "latin1");
const SEGMENT_NAME = "__SUI";
const LINKEDIT_SEGMENT_NAME = "__LINKEDIT";
const ELF_NOTE_OWNER = Buffer.from("SUI\0", "latin1");
const ELF_NOTE_TYPE = 0x53554901;
const PE_HEADER_PROBE_BYTES = 64 * 1024;
const INTEL_CHUNK_BYTES = 1024 * 1024;
/** Trailer candidates examined before the search stops. */
const MAX_DENO_INTEL_TRAILER_SENTINELS = 64;
const INTEL_SENTINEL = Buffer.concat([
  Buffer.from("<~sui-data~>", "latin1"),
  Buffer.from([0xef, 0xbe, 0xad, 0xde]),
]);

export interface DenoStandaloneLocation {
  readonly carrier: "mach-o" | "elf" | "pe";
  readonly embedding:
    | "mach-o-section"
    | "mach-o-intel-trailer"
    | "elf-note"
    | "pe-resource";
  readonly offset: number;
  readonly length: number;
}

export type DenoStandaloneProbe =
  | { readonly status: "absent" }
  | { readonly status: "present"; readonly location: DenoStandaloneLocation }
  | {
      readonly status: "present";
      readonly failure: ArtifactReaderFailure;
    };

interface SectionRange {
  readonly offset: number;
  readonly length: number;
  readonly embedding: DenoStandaloneLocation["embedding"];
}

interface IntelTrailer extends SectionRange {
  readonly sentinelOffset: number;
}

/** Absolute file range `[start, end)` owned by a native Mach-O segment. */
interface OwnedRange {
  readonly start: bigint;
  readonly end: bigint;
}

/**
 * One slice's Deno ranges. `unread` names why part of the slice could not be
 * examined, so a Deno section or trailer there remains unknown.
 */
interface SliceScan {
  readonly found: SectionRange[];
  readonly unread: string | null;
}

interface Carrier {
  readonly handle: FileHandle;
  readonly fileSize: number;
  readonly signal: AbortSignal | undefined;
  readonly archive:
    | { readonly start: number; readonly end: number }
    | undefined;
}

/**
 * Find a libsui 0.16 Deno section. Mach-O arm64 uses `__SUI,d3n0l4nd`.
 * Other thin Mach-O images use the `<~sui-data~>` trailer when that section
 * is absent and the payload opens with `d3n0l4nd`. ELF matches note owner
 * `SUI`, type `0x53554901`, and descriptor name `d3n0l4nd` from bounded
 * header reads. PE matches `RT_RCDATA` name `D3N0L4ND`. Only a confirmed name
 * makes a failure Deno's: a confirmed slot that is truncated or declared twice
 * with different bytes fails closed. Until then the image stays with native
 * inventory, so an unrelated malformed or crowded file keeps that inventory.
 * `absent` means no section was confirmed in the examined bytes.
 */
export const locateDenoStandalone = async (
  handle: FileHandle,
  fileSize: number,
  signal?: AbortSignal,
  archive?: { readonly start: number; readonly end: number },
): Promise<DenoStandaloneProbe> => {
  try {
    const location = await findDenoSection(handle, fileSize, signal, archive);
    return location === undefined
      ? { status: "absent" }
      : { status: "present", location };
  } catch (cause) {
    if (
      cause instanceof ArtifactReaderFailure &&
      (cause.reason === "format" || cause.reason === "limit")
    )
      return { status: "present", failure: cause };
    throw cause;
  }
};

const findDenoSection = async (
  handle: FileHandle,
  fileSize: number,
  signal?: AbortSignal,
  archive?: { readonly start: number; readonly end: number },
): Promise<DenoStandaloneLocation | undefined> => {
  if (!Number.isSafeInteger(fileSize) || fileSize < 4) return undefined;
  const carrier: Carrier = { handle, fileSize, signal, archive };
  const prefix = await readExact(carrier, 0, Math.min(fileSize, 64));
  if (prefix === undefined || prefix.length < 4) return undefined;
  const thin = readMachoHeaderPrefixFacts(prefix).format;
  const fat = readFatHeaderPrefix(prefix);
  if (thin !== null || fat.state === "incomplete" || fat.state === "parsed")
    return collapseRanges(carrier, "mach-o", await locateMachO(carrier));
  if (prefix.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])))
    return collapseRanges(carrier, "elf", await locateElfNotes(carrier));
  if (prefix[0] === 0x4d && prefix[1] === 0x5a)
    return collapseRanges(carrier, "pe", await locatePeResources(carrier));
  return undefined;
};

const locateMachO = async (carrier: Carrier): Promise<SectionRange[]> => {
  const readAt: ReadAt = async (offset, length) =>
    (await readExact(carrier, offset, length)) ?? Buffer.alloc(0);
  const container = await readMachoContainer(readAt, carrier.fileSize);
  if (container.kind !== "thin" && container.kind !== "fat") return [];
  if (container.kind === "thin")
    return (await locateMachOSlice(carrier, readAt, 0, carrier.fileSize, null))
      .found;
  const found: SectionRange[] = [];
  const unread: string[] = [];
  const scan = async (
    label: string,
    rangeIssue: string | null | undefined,
    declaration: FatSliceDeclaration,
  ): Promise<void> => {
    if (rangeIssue != null) {
      unread.push(`${label} ${rangeIssue}`);
      return;
    }
    const result = await locateMachOSlice(
      carrier,
      readAt,
      declaration.offset,
      declaration.size,
      declaration,
    );
    found.push(...result.found);
    if (result.unread !== null) unread.push(`${label} ${result.unread}`);
  };
  for (const [index, slice] of container.header.slices.entries())
    await scan(
      `slice ${String(index)}`,
      container.header.rangeIssues[index]?.reason,
      slice,
    );
  const hidden = container.hidden;
  if (hidden?.status === "declared")
    await scan("hidden slice", hidden.rangeIssue, hidden.declaration);
  // A sibling that could not be examined may declare a different Deno
  // application, so a section found elsewhere cannot stand for the whole
  // universal image. With none found, the image stays with native inventory.
  if (found.length > 0 && unread.length > 0)
    throw denoCarrierFailure(
      `universal Mach-O ${unread[0] ?? ""} beside a Deno section`,
    );
  return found;
};

const locateMachOSlice = async (
  carrier: Carrier,
  readAt: ReadAt,
  base: number,
  sliceSize: number,
  fat: FatSliceDeclaration | null,
): Promise<SliceScan> => {
  const table = await readSliceCommandTable(readAt, base, sliceSize);
  if (table.status !== "read")
    return { found: [], unread: `cannot be read: ${table.reason}` };
  // A FAT row that misstates the slice's CPU cannot choose how the slice is
  // searched, so the slice stays unread.
  const identityIssue =
    fat === null ? null : validateFatSliceIdentity(fat, table.header);
  if (identityIssue !== null) return { found: [], unread: identityIssue };
  const found: SectionRange[] = [];
  const owned: OwnedRange[] = [];
  if (carrier.archive !== undefined)
    owned.push({
      start: BigInt(carrier.archive.start),
      end: BigInt(carrier.archive.end),
    });
  let confirmed = false;
  // A __SUI segment is libsui's, but only a d3n0l4nd section in it makes the
  // image Deno's. Damage, including a segment that cannot be parsed, is kept
  // until that name is confirmed and otherwise leaves the slice unread.
  let damage: string | undefined;
  const framed = frameLoadCommands(table, (command) => {
    if (command.command !== LC_SEGMENT && command.command !== LC_SEGMENT_64)
      return;
    const segment64 = command.command === LC_SEGMENT_64;
    const parsedSegment = readMachoSegmentHeader(command.body, segment64, true);
    if (!parsedSegment.ok) {
      // An unparsed segment may be __SUI, so the slice is not fully examined.
      damage ??= "Mach-O segment command cannot be parsed";
      return;
    }
    const segment = parsedSegment.value;
    const admitted = admitMachoSegmentCommand(
      segment,
      command.body.byteLength,
      table.header.wide ? 64 : 32,
      sliceSize,
    );
    if (!admitted.ok) damage ??= admitted.error.message;
    if (segment64 !== table.header.wide)
      damage ??= "Mach-O segment command width disagrees with its header";
    const segmentName = fixedCString(segment.nameBytes);
    if (segmentName !== LINKEDIT_SEGMENT_NAME && segment.fileSize > 0n) {
      // libsui appends the Intel trailer after the image's content, inside
      // or past __LINKEDIT. Bytes any other segment maps belong to the native
      // image, so a sentinel there is stored data such as a __DATA asset.
      const start = BigInt(base) + segment.fileOffset;
      owned.push({ start, end: start + segment.fileSize });
    }
    if (segmentName !== SEGMENT_NAME) return;
    const sectionSize = segment64 ? 80 : 68;
    const fitting = Math.floor(
      (command.body.byteLength - segment.headerSize) / sectionSize,
    );
    for (
      let index = 0;
      index < Math.min(segment.sectionCount, fitting);
      index += 1
    ) {
      abortIfNeeded(carrier.signal);
      const at = segment.headerSize + index * sectionSize;
      const parsedSection = readMachoSectionHeader(
        command.body.subarray(at, at + sectionSize),
        segment64,
        true,
      );
      if (!parsedSection.ok) {
        if (namesDenoSection(command.body, at)) throw denoSectionTruncated();
        damage ??= "Mach-O __SUI section is truncated";
        return;
      }
      const record = parsedSection.value;
      if (fixedCString(record.nameBytes) !== SECTION_NAME) continue;
      confirmed = true;
      found.push(
        denoSectionRange(record, segment, base, sliceSize, carrier.fileSize),
      );
    }
    if (segment.sectionCount <= fitting) return;
    // The first record past the command may still hold its whole name.
    if (
      namesDenoSection(command.body, segment.headerSize + fitting * sectionSize)
    )
      throw denoSectionTruncated();
    damage ??= "Mach-O __SUI segment is truncated";
  });
  if (confirmed && damage !== undefined) throw denoCarrierFailure(damage);
  if (confirmed && framed.status !== "framed")
    throw denoCarrierFailure("Mach-O load commands are truncated");
  // Commands after a framing failure were not visited and may hold __SUI.
  // Without every segment framed, a trailer's ownership cannot be shown
  // either, so the image stays with native inventory.
  if (framed.status !== "framed")
    return {
      found,
      unread: `load commands cannot be framed: ${framed.reason}`,
    };
  // A damaged or unparsed segment may hold an unread d3n0l4nd section, so the
  // slice is not fully examined and the trailer search cannot stand for it.
  if (damage !== undefined) return { found, unread: damage };
  if (found.length > 0 || table.header.cpuType === CPU_TYPE_ARM64)
    return { found, unread: null };
  return locateIntelTrailers(carrier, base, sliceSize, owned);
};

/**
 * Whether the section record at `at` names `d3n0l4nd`. The 16-byte name is
 * read apart from the rest of the record, so a record truncated after its
 * name still confirms Deno.
 */
const namesDenoSection = (body: Uint8Array, at: number): boolean =>
  at + 16 <= body.byteLength &&
  fixedCString(body.subarray(at, at + 16)) === SECTION_NAME;

/**
 * The file range of a confirmed `d3n0l4nd` record, or a failure. A zero-fill
 * section owns no file bytes, so its declared offset names no payload. Bytes
 * outside the enclosing segment's file extent are not file backed either,
 * matching MachoImage, even when the file itself still holds them.
 */
const denoSectionRange = (
  record: {
    readonly address: bigint;
    readonly size: bigint;
    readonly offset: number;
    readonly flags: number;
  },
  segment: {
    readonly fileOffset: bigint;
    readonly fileSize: bigint;
    readonly address: bigint;
    readonly memorySize: bigint;
  },
  base: number,
  sliceSize: number,
  fileSize: number,
): SectionRange => {
  if (isMachoZeroFillSection(record.flags))
    throw denoCarrierFailure("Mach-O d3n0l4nd section is zero-fill");
  if (record.size > BigInt(Number.MAX_SAFE_INTEGER))
    throw denoCarrierFailure(
      "Mach-O d3n0l4nd section size is not a safe integer",
    );
  const virtualDelta = record.address - segment.address;
  if (
    virtualDelta < 0n ||
    virtualDelta > segment.memorySize ||
    record.size > segment.memorySize - virtualDelta
  )
    throw denoCarrierFailure(
      "Mach-O d3n0l4nd section exceeds its segment's virtual extent",
    );
  const segmentDelta = BigInt(record.offset) - segment.fileOffset;
  if (
    segmentDelta < 0n ||
    segmentDelta > segment.fileSize ||
    record.size > segment.fileSize - segmentDelta
  )
    throw denoCarrierFailure(
      "Mach-O d3n0l4nd section exceeds its segment's file extent",
    );
  const length = Number(record.size);
  const fileOffset = record.offset;
  if (
    fileOffset > sliceSize ||
    length > sliceSize - fileOffset ||
    base + fileOffset > fileSize ||
    length > fileSize - (base + fileOffset)
  )
    throw denoCarrierFailure("Mach-O d3n0l4nd section exceeds the image");
  return { offset: base + fileOffset, length, embedding: "mach-o-section" };
};

const denoSectionTruncated = (): ArtifactReaderFailure =>
  denoCarrierFailure("Mach-O d3n0l4nd section is truncated");

/**
 * libsui appends `<~sui-data~>` + `0xdeadbeef` + u64 length + payload. A code
 * signature may follow the payload, so the payload need not end at EOF. A
 * sentinel whose payload does not open with `d3n0l4nd` is not a Deno trailer:
 * the libsui constant appears in the runtime, and claiming it would fail
 * closed instead of leaving the image to native inventory.
 *
 * A confirmed trailer does not end the search: a virtual file can itself be
 * an Intel Deno executable, and the backward search meets that asset's
 * sentinel before the sentinel of the app that stores it. Sentinels inside a
 * confirmed payload are that payload's data, so only the remaining trailers
 * are returned, and `collapseRanges` rejects any that differ. A
 * marker-confirmed truncated trailer fails unless an enclosing trailer found
 * later in the search holds it as data. Each byte is read at most once. When
 * the slice cannot be searched to its start, a confirmed or truncated trailer
 * is refused because an enclosing one may remain unread, and with none
 * found the image stays with native inventory.
 *
 * A sentinel inside a range the native image's own segments map (other than
 * __LINKEDIT, which libsui extends over the trailer) is that image's data,
 * for example an Intel Deno executable stored as a `__DATA` asset of a
 * non-Deno host. Such a sentinel is not a trailer candidate.
 */
const locateIntelTrailers = async (
  carrier: Carrier,
  base: number,
  sliceSize: number,
  owned: readonly OwnedRange[],
): Promise<SliceScan> => {
  const overlap = INTEL_SENTINEL.length + 8;
  let position = base + sliceSize;
  let tail = Buffer.alloc(0);
  let examined = 0;
  let trailers: IntelTrailer[] = [];
  /** Sentinels of marker-confirmed trailers whose payload runs past the slice. */
  let truncated: number[] = [];
  /** Sentinels of marker-confirmed trailers too short to hold their marker. */
  let undersized: number[] = [];
  const pending = (): boolean =>
    trailers.length > 0 || truncated.length > 0 || undersized.length > 0;
  while (position > base) {
    abortIfNeeded(carrier.signal);
    const chunkStart = Math.max(base, position - INTEL_CHUNK_BYTES);
    const chunk = await readExact(carrier, chunkStart, position - chunkStart);
    if (chunk === undefined) {
      if (pending())
        throw denoCarrierFailure("Intel Mach-O slice is truncated");
      return { found: [], unread: "is truncated before its trailer search" };
    }
    const window = tail.length === 0 ? chunk : Buffer.concat([chunk, tail]);
    let searchFrom = chunk.length - 1;
    while (searchFrom >= 0) {
      const index = window.lastIndexOf(INTEL_SENTINEL, searchFrom);
      if (index < 0 || index > searchFrom) break;
      examined += 1;
      if (examined > MAX_DENO_INTEL_TRAILER_SENTINELS) {
        if (pending()) throw denoIntelSentinelLimit();
        return {
          found: [],
          unread: `has more than ${String(MAX_DENO_INTEL_TRAILER_SENTINELS)} trailer sentinels`,
        };
      }
      const lengthAt = index + INTEL_SENTINEL.length;
      const sentinelStart = chunkStart + index;
      searchFrom = index - 1;
      const at = BigInt(sentinelStart);
      if (owned.some((range) => at >= range.start && at < range.end)) continue;
      if (lengthAt + 8 > window.length) continue;
      const claimed = window.readBigUInt64LE(lengthAt);
      const sliceEnd = base + sliceSize;
      const offset = sentinelStart + INTEL_SENTINEL.length + 8;
      if (offset < base || offset > sliceEnd) continue;
      // The marker is checked before the length is judged, so an undersized,
      // oversized or unsafe length word cannot hide a confirmed trailer.
      const marker = await readExact(
        carrier,
        offset,
        DENO_SECTION_MAGIC.length,
      );
      if (marker === undefined || !marker.equals(DENO_SECTION_MAGIC)) continue;
      if (claimed < BigInt(DENO_SECTION_MAGIC.length)) {
        // A length shorter than the marker is malformed. Like a truncated
        // trailer, it fails closed unless an enclosing trailer holds it.
        undersized.push(sentinelStart);
        continue;
      }
      if (claimed > BigInt(sliceEnd - offset)) {
        // A marker-confirmed trailer whose payload runs past the slice is a
        // truncated Deno app, whether or not it would enclose a confirmed
        // trailer. The sentinel may still be stored data of an enclosing
        // trailer the backward search has not reached, so the failure waits
        // until the search ends.
        truncated.push(sentinelStart);
        continue;
      }
      const length = Number(claimed);
      const end = offset + length;
      const inside = (at: number): boolean => at >= offset && at < end;
      trailers = trailers.filter((trailer) => !inside(trailer.sentinelOffset));
      truncated = truncated.filter((at) => !inside(at));
      undersized = undersized.filter((at) => !inside(at));
      trailers.push({
        sentinelOffset: sentinelStart,
        offset,
        length,
        embedding: "mach-o-intel-trailer",
      });
    }
    tail = Buffer.from(chunk.subarray(0, Math.min(chunk.length, overlap)));
    position = chunkStart;
  }
  if (truncated.length > 0)
    throw denoCarrierFailure("Intel Mach-O Deno trailer is truncated");
  if (undersized.length > 0)
    throw denoCarrierFailure(
      "Intel Mach-O Deno trailer length is shorter than its marker",
    );
  return { found: trailers, unread: null };
};

interface ElfNoteTable {
  offset: number;
  length: number;
  alignment: number;
  copies: number;
}

/** First structural problem seen. It is Deno's only if a SUI note is confirmed. */
interface ElfNoteWalk {
  readonly found: SectionRange[];
  damage: ArtifactReaderFailure | undefined;
}

/**
 * Locate a SUI note from ELF and note headers. The image is not loaded whole
 * and note descriptors are not hashed. A file larger than the note parser's
 * input ceiling stays locatable when the headers fit. A table that cannot be
 * read is skipped so another table can still hold the note. With no SUI note,
 * skipped tables leave the ELF to native inventory, and with one they fail
 * closed, as damaged Mach-O load commands do around `__SUI`.
 */
const locateElfNotes = async (carrier: Carrier): Promise<SectionRange[]> => {
  const prefix = await readExact(carrier, 0, Math.min(carrier.fileSize, 64));
  if (prefix === undefined) return [];
  const header = readElfFixedHeader(prefix, carrier.fileSize);
  if (!header.ok) return [];
  const headerBytes =
    prefix.length >= header.value.headerSize
      ? prefix.subarray(0, header.value.headerSize)
      : await readExact(carrier, 0, header.value.headerSize);
  if (headerBytes === undefined) return [];
  const raw = readElfRawTableDeclarations(headerBytes, header.value);
  if (!raw.ok) return [];
  const walk: ElfNoteWalk = { found: [], damage: undefined };
  const damaged = (detail: string): void => {
    walk.damage ??= denoCarrierFailure(detail);
  };
  const little = header.value.byteOrder === "little";
  const wide = header.value.elfClass === 64;
  const { programs, sections } = raw.value;
  if (programs.count === PN_XNUM)
    damaged("ELF extended program numbering is unsupported");
  // A zero e_shnum with a section table moves the count into section zero.
  if (sections.count === 0 && sections.offset !== 0n)
    damaged("ELF extended section numbering is unsupported");
  const programHeaders =
    programs.count === PN_XNUM
      ? undefined
      : await readElfHeaderTable(
          carrier,
          walk,
          programs,
          wide ? ELF64_PROGRAM_HEADER_BYTES : ELF32_PROGRAM_HEADER_BYTES,
          "program header table",
        );
  const sectionHeaders = await readElfHeaderTable(
    carrier,
    walk,
    sections,
    wide ? ELF64_SECTION_HEADER_BYTES : ELF32_SECTION_HEADER_BYTES,
    "section header table",
  );
  const tables = new Map<string, ElfNoteTable>();
  const addTable = (offset: bigint, length: bigint, align: bigint): void => {
    if (
      offset < 0n ||
      length < 0n ||
      offset > BigInt(carrier.fileSize) ||
      length > BigInt(carrier.fileSize) - offset
    ) {
      damaged("ELF note table is truncated");
      return;
    }
    const fileOffset = Number(offset);
    const fileLength = Number(length);
    const alignment = elfNoteAlignment(align);
    const key = `${String(fileOffset)}:${String(fileLength)}:${String(alignment)}`;
    const existing = tables.get(key);
    if (existing !== undefined) {
      existing.copies += 1;
      return;
    }
    tables.set(key, {
      offset: fileOffset,
      length: fileLength,
      alignment,
      copies: 1,
    });
  };
  if (programHeaders !== undefined)
    for (
      let index = 0;
      index < programHeaders.length;
      index += programs.width
    ) {
      if (index % (programs.width * 128) === 0) abortIfNeeded(carrier.signal);
      const parsed = readElfProgramHeader(
        programHeaders.subarray(index, index + programs.width),
        header.value.elfClass,
        little,
      );
      if (!parsed.ok) {
        damaged(parsed.error.message);
        continue;
      }
      if (parsed.value.type !== PT_NOTE) continue;
      addTable(
        parsed.value.offset,
        parsed.value.fileSize,
        parsed.value.alignment,
      );
    }
  if (sectionHeaders !== undefined)
    for (
      let index = 0;
      index < sectionHeaders.length;
      index += sections.width
    ) {
      if (index % (sections.width * 128) === 0) abortIfNeeded(carrier.signal);
      const parsed = readElfSectionHeader(
        sectionHeaders.subarray(index, index + sections.width),
        header.value.elfClass,
        little,
      );
      if (!parsed.ok) {
        damaged(parsed.error.message);
        continue;
      }
      if (parsed.value.type !== SHT_NOTE) continue;
      if (parsed.value.compressed) {
        damaged("compressed ELF note sections are unsupported");
        continue;
      }
      addTable(parsed.value.offset, parsed.value.size, parsed.value.alignment);
    }
  let minimumNotes = 0;
  // Every nonempty table costs at least one read, a short one for its
  // trailing bytes, so each counts against the note allowance.
  for (const table of tables.values())
    if (table.length > 0) minimumNotes += table.copies;
  let examined = 0;
  if (minimumNotes > MAX_INSPECT_ELF_NOTE_ENTRIES)
    walk.damage ??= denoElfNoteLimit();
  else
    for (const table of tables.values()) {
      const notes = await scanElfNoteTable(
        carrier,
        walk,
        table,
        little,
        examined,
      );
      examined += notes * table.copies;
      if (examined > MAX_INSPECT_ELF_NOTE_ENTRIES) break;
    }
  if (walk.found.length > 0 && walk.damage !== undefined) throw walk.damage;
  return walk.found;
};

/**
 * Read one header table at its canonical record size. A u16 count bounds the
 * read at 65,535 records of at most 64 bytes.
 */
const readElfHeaderTable = async (
  carrier: Carrier,
  walk: ElfNoteWalk,
  table: { offset: bigint; width: number; count: number },
  canonicalWidth: number,
  label: string,
): Promise<Buffer | undefined> => {
  if (table.count === 0) return undefined;
  const bytes = table.count * canonicalWidth;
  const body =
    table.width === canonicalWidth && table.offset <= BigInt(carrier.fileSize)
      ? await readExact(carrier, Number(table.offset), bytes)
      : undefined;
  if (body === undefined)
    walk.damage ??= denoCarrierFailure(`ELF ${label} cannot be read`);
  return body;
};

const scanElfNoteTable = async (
  carrier: Carrier,
  walk: ElfNoteWalk,
  table: ElfNoteTable,
  little: boolean,
  examined: number,
): Promise<number> => {
  const stop = (detail: string, notes: number): number => {
    walk.damage ??= denoCarrierFailure(detail);
    return notes;
  };
  let cursor = 0;
  let notes = 0;
  while (cursor + 12 <= table.length) {
    abortIfNeeded(carrier.signal);
    notes += 1;
    if (examined + notes * table.copies > MAX_INSPECT_ELF_NOTE_ENTRIES) {
      walk.damage ??= denoElfNoteLimit();
      return notes;
    }
    const header = await readExact(carrier, table.offset + cursor, 12);
    if (header === undefined)
      return stop("ELF note header is truncated", notes);
    const parsed = readElfNoteHeader(header, little);
    if (!parsed.ok) return stop(parsed.error.message, notes);
    const { namesz, descsz, type } = parsed.value;
    const layout = elfNoteLayout(namesz, descsz, table.alignment);
    const sui = namesz === ELF_NOTE_OWNER.length && type === ELF_NOTE_TYPE;
    if (
      !Number.isSafeInteger(layout.descriptor) ||
      !Number.isSafeInteger(layout.next) ||
      layout.next < 12 ||
      layout.next > table.length - cursor
    ) {
      // The owner and descriptor name are read within the table, apart from
      // the claimed extent, so a confirmed Deno note still fails closed.
      if (sui && (await confirmsSuiNote(carrier, table, cursor, layout)))
        throw denoCarrierFailure("ELF SUI note entry exceeds its table");
      return stop("ELF note entry exceeds its table", notes);
    }
    if (sui) {
      const name = await readExact(carrier, table.offset + cursor + 12, namesz);
      if (name === undefined) return stop("ELF note name is truncated", notes);
      if (name.equals(ELF_NOTE_OWNER)) {
        const payload = await readSuiRange(
          carrier,
          table.offset + cursor + layout.descriptor,
          descsz,
        );
        if (payload !== undefined) walk.found.push(payload);
      }
    }
    cursor += layout.next;
  }
  if (cursor >= table.length) return notes;
  // A table too short for any note still costs one read of its tail.
  const counted = Math.max(notes, 1);
  const tailIssue =
    examined + counted * table.copies > MAX_INSPECT_ELF_NOTE_ENTRIES
      ? denoElfNoteLimit()
      : await noteTableTailIssue(carrier, table, cursor);
  walk.damage ??= tailIssue;
  return counted;
};

/**
 * Fewer than 12 bytes remain after the last note. Zero padding is accepted;
 * anything else is unaccounted table data, which is Deno's only if a SUI
 * note is confirmed.
 */
const noteTableTailIssue = async (
  carrier: Carrier,
  table: ElfNoteTable,
  cursor: number,
): Promise<ArtifactReaderFailure | undefined> => {
  const tail = await readExact(
    carrier,
    table.offset + cursor,
    table.length - cursor,
  );
  if (tail === undefined)
    return denoCarrierFailure("ELF note table is truncated");
  if (tail.some((byte) => byte !== 0))
    return denoCarrierFailure("ELF note table has trailing non-zero bytes");
  return undefined;
};

/** Whether a SUI note whose extent was rejected still names `d3n0l4nd`. */
const confirmsSuiNote = async (
  carrier: Carrier,
  table: ElfNoteTable,
  cursor: number,
  layout: { readonly descriptor: number },
): Promise<boolean> => {
  const wanted = layout.descriptor + 2 + SECTION_NAME_BYTES.length;
  if (!Number.isSafeInteger(wanted) || wanted > table.length - cursor)
    return false;
  const at = table.offset + cursor;
  const name = await readExact(carrier, at + 12, ELF_NOTE_OWNER.length);
  if (name === undefined || !name.equals(ELF_NOTE_OWNER)) return false;
  const prefix = await readExact(
    carrier,
    at + layout.descriptor,
    2 + SECTION_NAME_BYTES.length,
  );
  return (
    prefix !== undefined &&
    prefix.readUInt16LE(0) === SECTION_NAME_BYTES.length &&
    prefix.subarray(2).equals(SECTION_NAME_BYTES)
  );
};

const readSuiRange = async (
  carrier: Carrier,
  descriptorOffset: number,
  descriptorLength: number,
): Promise<SectionRange | undefined> => {
  if (descriptorLength < 2) return undefined;
  const wanted = Math.min(descriptorLength, 2 + SECTION_NAME_BYTES.length);
  const prefix = await readExact(carrier, descriptorOffset, wanted);
  if (prefix === undefined)
    throw denoCarrierFailure("ELF SUI descriptor is truncated");
  const nameLength = prefix.readUInt16LE(0);
  if (nameLength !== SECTION_NAME_BYTES.length) return undefined;
  // A descriptor too short for the whole name has not shown `d3n0l4nd`, so
  // the note stays unconfirmed and the image stays with native inventory.
  if (2 + nameLength > descriptorLength || prefix.length < 2 + nameLength)
    return undefined;
  if (!prefix.subarray(2, 2 + nameLength).equals(SECTION_NAME_BYTES))
    return undefined;
  const length = descriptorLength - 2 - nameLength;
  const offset = descriptorOffset + 2 + nameLength;
  if (offset > carrier.fileSize || length > carrier.fileSize - offset)
    throw denoCarrierFailure("ELF SUI descriptor is truncated");
  return { offset, length, embedding: "elf-note" };
};

const locatePeResources = async (carrier: Carrier): Promise<SectionRange[]> => {
  const headers = await readExact(
    carrier,
    0,
    Math.min(carrier.fileSize, PE_HEADER_PROBE_BYTES),
  );
  if (headers === undefined) return [];
  const payloads = await locatePeResourcePayloads(
    headers,
    carrier.fileSize,
    (offset, length) => readExact(carrier, offset, length),
    RT_RCDATA,
    RESOURCE_NAME,
    MAX_INSPECT_PE_DIRECTORY_ENTRIES,
  );
  return payloads.map(({ offset, bytes }) => {
    if (bytes > MAX_INSPECT_PE_FILE_BYTES) throw denoPeLimit();
    return { offset, length: bytes, embedding: "pe-resource" };
  });
};

const collapseRanges = async (
  carrier: Carrier,
  kind: DenoStandaloneLocation["carrier"],
  ranges: readonly SectionRange[],
): Promise<DenoStandaloneLocation | undefined> => {
  const unique: SectionRange[] = [];
  const seen = new Set<string>();
  for (const range of ranges) {
    const key = `${String(range.offset)}:${String(range.length)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(range);
  }
  const chosen = unique[0];
  if (chosen === undefined) return undefined;
  if (unique.length > 1) {
    const conflict = () =>
      denoCarrierFailure(
        "Deno compile section is declared more than once with different bytes",
      );
    if (unique.some((range) => range.length !== chosen.length))
      throw conflict();
    // Disjoint copies fit in the carrier. Overlapping declarations must not
    // multiply payload reads beyond one carrier's worth of verification work.
    let remainingBytes = carrier.fileSize;
    let chosenHash: string | undefined;
    for (const range of unique) {
      if (range.length > remainingBytes)
        throw denoLimit(
          "Deno compile duplicate-section verification exceeds the carrier file-size byte allowance. This release has no runtime override.",
          "capacity",
        );
      remainingBytes -= range.length;
      const hash = await hashArtifactRange(carrier, range.offset, range.length);
      if (hash === undefined)
        throw denoCarrierFailure("Deno compile section is truncated");
      if (chosenHash === undefined) chosenHash = hash;
      else if (hash !== chosenHash) throw conflict();
    }
  }
  return {
    carrier: kind,
    embedding: chosen.embedding,
    offset: chosen.offset,
    length: chosen.length,
  };
};

const fixedCString = (bytes: Uint8Array): string => {
  const end = bytes.indexOf(0);
  return Buffer.from(end < 0 ? bytes : bytes.subarray(0, end)).toString(
    "latin1",
  );
};

const denoCarrierFailure = (detail: string): ArtifactReaderFailure =>
  new ArtifactReaderFailure(
    "format",
    `Deno compile carrier is malformed: ${detail}`,
  );

const denoLimit = (
  message: string,
  boundary: "capacity" | "file-size",
): ArtifactReaderFailure =>
  new ArtifactReaderFailure("limit", message, {
    boundary,
    userMessage: message,
  });

const denoIntelSentinelLimit = (): ArtifactReaderFailure =>
  denoLimit(
    `Deno compile Intel trailer search exceeds the fixed ${String(MAX_DENO_INTEL_TRAILER_SENTINELS)}-sentinel allowance before reaching the start of the image, so an enclosing trailer may remain unread. This release has no runtime override.`,
    "capacity",
  );

const denoElfNoteLimit = (): ArtifactReaderFailure =>
  denoLimit(
    `Deno compile ELF notes exceed the fixed ${String(MAX_INSPECT_ELF_NOTE_ENTRIES)}-note allowance. This release has no runtime override. Host memory and NODE_OPTIONS do not raise it.`,
    "capacity",
  );

const denoPeLimit = (): ArtifactReaderFailure =>
  denoLimit(
    "Deno compile PE resource payload exceeds the 512 MiB resource reader ceiling. This release has no runtime override.",
    "file-size",
  );
