import { hasElfMagic } from "../../domain/binaryContainer.js";
import { hasDosMzMagic } from "../../domain/dosMz.js";
import { LC } from "../../domain/apple/machoLoadCommandCodes.js";
import {
  hashArtifactRange,
  readArtifactRange as readExact,
} from "../ArtifactCarrierRange.js";
import {
  admitMachoSegmentCommand,
  readMachoSegmentHeader,
} from "../../domain/apple/machoSegmentHeader.js";
import {
  machoSectionBacking,
  readMachoSectionHeader,
} from "../../domain/apple/machoSectionHeader.js";
import {
  elfSectionHeaderWidth,
  readElfSectionHeader,
} from "../../domain/elfSectionHeader.js";
import {
  elfProgramHeaderWidth,
  readElfProgramHeader,
} from "../../domain/elfProgramHeader.js";
import { readElfRawTableDeclarations } from "../../domain/elfRawTableDeclarations.js";
import { validateElfSectionTableFields } from "../../domain/elfDeclaredRanges.js";
import { constants as bufferConstants } from "node:buffer";
import {
  readPeResourceEntries,
  peResourceLimitBoundary,
} from "../../domain/pe/peResourceInventory.js";
import {
  hasPeResourceName,
  readPeResourceLayout,
} from "../../domain/pe/peResourceLayout.js";
import {
  MAX_INSPECT_PE_FILE_BYTES,
  MAX_INSPECT_PE_DIRECTORY_ENTRIES,
} from "../../domain/native/peResources.js";
import type { FileHandle } from "node:fs/promises";
import type { StableRegularFileDescriptor } from "../../filesystem/RegularFile.js";

import {
  ArtifactReaderFailure,
  malformedArtifact,
  truncatedArtifact,
  artifactParseFailure,
  artifactReaderLimitFailure,
  artifactFixedLimitFailure,
  abortIfNeeded,
} from "../../resources/index.js";
import { ParseFailureError } from "../../domain/parseFailure.js";
import {
  DEFAULT_NODE_SEA_READER_LIMITS,
  type NodeSeaReaderLimits,
} from "../../domain/artifactReaderLimits.js";
import {
  readFatContainerHeader,
  readFatHeaderPrefix,
  readMachoHeaderPrefixFacts,
  validateFatSliceIdentity,
  type FatSliceDeclaration,
} from "../../domain/apple/machoContainer.js";
import { readElfFixedHeader } from "../../domain/elfFixedHeader.js";
import {
  MachoLoadCommandCursor,
  readMachoLoadCommandTableHeader,
} from "../../domain/apple/machoLoadCommands.js";
import {
  ELF_NOTE_HEADER_BYTES,
  elfNoteAlignment,
  elfNoteSectionStorage,
  isElfNotePadding,
  readElfNoteFrame,
} from "../../domain/native/elfNoteLayout.js";
import {
  NODE_SEA_DUPLICATE_BLOB,
  NODE_SEA_ELF_DESCRIPTOR_TRUNCATED,
  NODE_SEA_ELF_NOTES_REPEATED,
  NODE_SEA_ELF_TABLE_TRUNCATED,
  NODE_SEA_MACHO_COMMANDS_TRUNCATED,
  NODE_SEA_MACHO_SEGMENT_TRUNCATED,
  NODE_SEA_TRUNCATED,
  observeNodeSeaFuseMatches,
  type NodeSeaFuseObservation,
} from "./NodeSeaBlob.js";

const PT_NOTE = 4;
const RT_RCDATA = 10;
const RESOURCE_NAME = "NODE_SEA_BLOB";
const SEA_SECTION = "__NODE_SEA_BLOB";
const FUSE_LENGTH = "NODE_SEA_FUSE_".length + 32 + 2;
// PE header structures must fit this prefix for the bounded name probe.

/** One injected blob inside a native carrier. Offsets are carrier file offsets. */
export interface NodeSeaLocation {
  readonly carrier: "mach-o" | "elf" | "pe";
  readonly blobOffset: number;
  readonly blobLength: number;
}

interface BlobRange {
  readonly offset: number;
  readonly length: number;
}

interface MachoSliceScan {
  readonly ranges: readonly BlobRange[];
  readonly identityIssue?: string;
}

const EMPTY_MACHO_SLICE: MachoSliceScan = { ranges: [] };

interface Carrier {
  readonly handle: FileHandle;
  readonly fileSize: number;
  readonly signal: AbortSignal | undefined;
  readonly limits?: NodeSeaReaderLimits;
}

const formatFailure = (message: string): ArtifactReaderFailure =>
  malformedArtifact("node-sea", message);

const truncatedFailure = (message: string): ArtifactReaderFailure =>
  truncatedArtifact("node-sea", message);

const limitFailure = (message: string): ArtifactReaderFailure =>
  new ArtifactReaderFailure("limit", message, { boundary: "memory" });

const admitBlobBytes = (carrier: Carrier, required: number): void => {
  const limits = carrier.limits ?? DEFAULT_NODE_SEA_READER_LIMITS;
  if (required > limits.blob_bytes)
    throw artifactReaderLimitFailure(
      "artifact_limits.node_sea.blob_bytes",
      limits.blob_bytes,
      "bytes",
      required,
      "memory",
    );
  if (required > bufferConstants.MAX_LENGTH)
    throw limitFailure(
      `Node SEA blob requires ${String(required)} bytes, exceeding this runtime's ${String(bufferConstants.MAX_LENGTH)}-byte Buffer representation limit; increasing artifact_limits.node_sea.blob_bytes cannot raise that runtime limit`,
    );
};

/**
 * Find a postject `NODE_SEA_BLOB` slot. Mach-O accepts segment `NODE_SEA`
 * (the postject name) and `__NODE_SEA`. ELF matches the full note owner
 * `NODE_SEA_BLOB` in `PT_NOTE` and `SHT_NOTE`. PE matches RCDATA type 10
 * named `NODE_SEA_BLOB`. Tables that cannot be parsed before that name is
 * confirmed leave the carrier unrecognized. A confirmed slot that is
 * truncated, ambiguous, or declared twice fails closed.
 */
export const locateNodeSea = async (
  handle: FileHandle,
  fileSize: number,
  signal?: AbortSignal,
  limits: NodeSeaReaderLimits = DEFAULT_NODE_SEA_READER_LIMITS,
): Promise<NodeSeaLocation | undefined> => {
  if (!Number.isSafeInteger(fileSize) || fileSize < 4) return undefined;
  const carrier: Carrier = { handle, fileSize, signal, limits };
  const prefix = await readExact(carrier, 0, Math.min(fileSize, 64));
  if (prefix === undefined || prefix.length < 4) return undefined;
  const thin = readMachoHeaderPrefixFacts(prefix).format;
  const fat = readFatHeaderPrefix(prefix);
  if (thin !== null || fat.state === "incomplete" || fat.state === "parsed") {
    const ranges =
      thin !== null
        ? (await locateThinMachO(carrier, 0, fileSize)).ranges
        : await locateFatMachO(carrier, prefix);
    return collapseRanges(carrier, "mach-o", ranges);
  }
  if (hasElfMagic(prefix))
    return collapseRanges(
      carrier,
      "elf",
      await locateElfNotes(carrier, prefix),
    );
  if (hasDosMzMagic(prefix))
    return collapseRanges(
      carrier,
      "pe",
      await locatePeResources(carrier, prefix),
    );
  return undefined;
};

/** Read a located blob, refusing declarations above the in-memory cap. */
export const readNodeSeaBlob = async (
  source: StableRegularFileDescriptor,
  location: NodeSeaLocation,
  signal?: AbortSignal,
  limits: NodeSeaReaderLimits = DEFAULT_NODE_SEA_READER_LIMITS,
): Promise<Buffer> => {
  const {
    handle,
    initial: { size: fileSize },
  } = source;
  admitBlobBytes({ handle, fileSize, signal, limits }, location.blobLength);
  const bytes = await readExact(
    { handle, fileSize, signal },
    location.blobOffset,
    location.blobLength,
  );
  if (bytes === undefined) throw truncatedFailure(NODE_SEA_TRUNCATED);
  return bytes;
};

const FUSE_PREFIX_BYTES = Buffer.from("NODE_SEA_FUSE_", "ascii");

const isLowerHexByte = (byte: number): boolean =>
  (byte >= 0x30 && byte <= 0x39) || (byte >= 0x61 && byte <= 0x66);

const isNodeSeaFuseAt = (buffer: Buffer, offset: number): boolean => {
  if (offset + FUSE_LENGTH > buffer.length) return false;
  const hashStart = offset + FUSE_PREFIX_BYTES.length;
  for (let index = 0; index < 32; index += 1) {
    if (!isLowerHexByte(buffer[hashStart + index]!)) return false;
  }
  if (buffer[hashStart + 32] !== 0x3a) return false; // ':'
  const state = buffer[hashStart + 33];
  return state === 0x30 || state === 0x31; // '0' | '1'
};

/**
 * Stream the carrier for `NODE_SEA_FUSE_<hash>:[01]`. The blob bytes are
 * included, so a script that embeds the sentinel text is observed too.
 */
export const scanNodeSeaFuse = async (
  handle: FileHandle,
  fileSize: number,
  signal?: AbortSignal,
): Promise<NodeSeaFuseObservation> => {
  const matches = new Set<string>();
  const overlap = FUSE_LENGTH - 1;
  const chunkSize = 64 * 1024;
  const scratch = Buffer.allocUnsafe(overlap + chunkSize);
  let carryLength = 0;
  let position = 0;
  while (position < fileSize) {
    const length = Math.min(chunkSize, fileSize - position);
    let filled = 0;
    while (filled < length) {
      abortIfNeeded(signal);
      const observed = await handle.read(
        scratch,
        carryLength + filled,
        length - filled,
        position + filled,
      );
      abortIfNeeded(signal);
      if (observed.bytesRead === 0)
        throw new ArtifactReaderFailure(
          "integrity",
          "Node SEA carrier shrank during the fuse scan",
          { integrityCheck: "read-coverage" },
        );
      filled += observed.bytesRead;
    }
    const windowLength = carryLength + length;
    const window = scratch.subarray(0, windowLength);
    let searchFrom = 0;
    while (searchFrom <= windowLength - FUSE_LENGTH) {
      const hit = window.indexOf(FUSE_PREFIX_BYTES, searchFrom);
      if (hit < 0 || hit > windowLength - FUSE_LENGTH) break;
      if (isNodeSeaFuseAt(window, hit)) {
        matches.add(window.toString("ascii", hit, hit + FUSE_LENGTH));
        // Two distinct sentinels already establish conflict. The public fact
        // needs no unbounded set of all sentinel-like strings in asset bytes.
        if (matches.size > 1) return observeNodeSeaFuseMatches([...matches]);
        searchFrom = hit + FUSE_LENGTH;
      } else {
        searchFrom = hit + 1;
      }
    }
    carryLength = Math.min(overlap, windowLength);
    if (carryLength > 0)
      scratch.copyWithin(0, windowLength - carryLength, windowLength);
    position += length;
  }
  return observeNodeSeaFuseMatches([...matches]);
};

const collapseRanges = async (
  carrier: Carrier,
  kind: NodeSeaLocation["carrier"],
  ranges: readonly BlobRange[],
): Promise<NodeSeaLocation | undefined> => {
  const unique: BlobRange[] = [];
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
    if (unique.some((range) => range.length !== chosen.length))
      throw formatFailure(NODE_SEA_DUPLICATE_BLOB);
    // Disjoint copies fit in the file; overlapping declarations must not
    // multiply verification work by the number of native table entries.
    let remainingBytes = carrier.fileSize;
    for (const range of unique) {
      if (range.length > remainingBytes)
        throw artifactFixedLimitFailure(
          {
            name: "Node SEA duplicate-blob verification allowance",
            kind: "work",
            limit: carrier.fileSize,
            unit: "bytes",
          },
          "Node SEA duplicate-blob verification exceeds the carrier-byte work allowance.",
        );
      remainingBytes -= range.length;
    }
    const hashes = new Set<string>();
    for (const range of unique) {
      const hash = await hashArtifactRange(carrier, range.offset, range.length);
      if (hash === undefined) throw truncatedFailure(NODE_SEA_TRUNCATED);
      hashes.add(hash);
    }
    if (hashes.size !== 1) throw formatFailure(NODE_SEA_DUPLICATE_BLOB);
  }
  return {
    carrier: kind,
    blobOffset: chosen.offset,
    blobLength: chosen.length,
  };
};

const locateFatMachO = async (
  carrier: Carrier,
  prefix: Buffer,
): Promise<readonly BlobRange[]> => {
  let bytes = prefix;
  let header = readFatContainerHeader(bytes, carrier.fileSize);
  if (header.state === "needs-data") {
    const required = await readExact(
      carrier,
      0,
      Math.min(carrier.fileSize, header.requiredBytes),
    );
    if (required === undefined || required.length < header.requiredBytes)
      return [];
    bytes = required;
    header = readFatContainerHeader(bytes, carrier.fileSize);
  }
  if (header.state !== "parsed") {
    if (readMachoHeaderPrefixFacts(bytes).format !== null)
      return (await locateThinMachO(carrier, 0, carrier.fileSize)).ranges;
    return [];
  }
  const found: BlobRange[] = [];
  let identityIssue: string | undefined;
  for (const [index, slice] of header.slices.entries()) {
    if (slice === undefined || header.rangeIssues[index] != null) continue;
    const scan = await locateThinMachO(
      carrier,
      slice.offset,
      slice.size,
      slice,
    );
    for (const range of scan.ranges) found.push(range);
    identityIssue ??= scan.identityIssue;
  }
  if (found.length === 0 && identityIssue !== undefined)
    throw formatFailure(identityIssue);
  return found;
};

const locateThinMachO = async (
  carrier: Carrier,
  base: number,
  sliceSize: number,
  fat?: FatSliceDeclaration,
): Promise<MachoSliceScan> => {
  if (
    !Number.isSafeInteger(base) ||
    !Number.isSafeInteger(sliceSize) ||
    base < 0 ||
    sliceSize < 4 ||
    base > carrier.fileSize ||
    sliceSize > carrier.fileSize - base
  )
    return EMPTY_MACHO_SLICE;
  const header = await readExact(carrier, base, Math.min(32, sliceSize));
  if (header === undefined) return EMPTY_MACHO_SLICE;
  const framing = readMachoLoadCommandTableHeader(header, sliceSize);
  if (!framing.ok || framing.value === null) return EMPTY_MACHO_SLICE;
  const identityIssue =
    fat === undefined
      ? null
      : validateFatSliceIdentity(fat, framing.value.identity);
  const {
    headerSize,
    littleEndian: little,
    commandBytes: sizeofcmds,
  } = framing.value;
  const limits = carrier.limits ?? DEFAULT_NODE_SEA_READER_LIMITS;
  if (sizeofcmds > limits.recognition_load_command_bytes) {
    if (identityIssue !== null) return EMPTY_MACHO_SLICE;
    throw artifactReaderLimitFailure(
      "artifact_limits.node_sea.recognition_load_command_bytes",
      limits.recognition_load_command_bytes,
      "bytes",
      sizeofcmds,
      "memory",
    );
  }
  const commands = await readExact(carrier, base + headerSize, sizeofcmds);
  if (commands === undefined) return EMPTY_MACHO_SLICE;
  const found: BlobRange[] = [];
  const cursor = new MachoLoadCommandCursor(framing.value);
  while (cursor.nextOffset !== null) {
    abortIfNeeded(carrier.signal);
    const read = cursor.read(commands.subarray(cursor.nextOffset));
    if (!read.ok) break;
    const { command: cmd, offset, size } = read.value;
    if (cmd === LC.SEGMENT || cmd === LC.SEGMENT_64) {
      const segment64 = cmd === LC.SEGMENT_64;
      const sectionSize = segment64 ? 80 : 68;
      const parsedSegment = readMachoSegmentHeader(
        commands.subarray(offset, offset + size),
        segment64,
        little,
      );
      // Incomplete segments cannot establish a SEA carrier. Interpret names
      // and section framing only from the shared fixed-record observation.
      const segment = parsedSegment.ok ? parsedSegment.value : undefined;
      const name =
        segment === undefined ? undefined : cString(segment.nameBytes, 0, 16);
      if (
        segment !== undefined &&
        (name === "NODE_SEA" || name === "__NODE_SEA")
      ) {
        const segmentHeader = segment.headerSize;
        const nsects = segment.sectionCount;
        const table = offset + segmentHeader;
        if (nsects > Math.floor((size - segmentHeader) / sectionSize)) {
          if (identityIssue !== null) continue;
          throw truncatedFailure(NODE_SEA_MACHO_SEGMENT_TRUNCATED);
        }
        const admission = admitMachoSegmentCommand(
          segment,
          size,
          framing.value.wide ? 64 : 32,
          sliceSize,
        );
        for (let index = 0; index < nsects; index += 1) {
          const section = table + index * sectionSize;
          const parsedSection = readMachoSectionHeader(
            commands.subarray(section, section + sectionSize),
            segment64,
            little,
          );
          if (!parsedSection.ok)
            throw truncatedFailure(NODE_SEA_MACHO_SEGMENT_TRUNCATED);
          const record = parsedSection.value;
          if (cString(record.nameBytes, 0, 16) !== SEA_SECTION) continue;
          // Only a named declaration is attributed to SEA. A mismatch
          // cannot supply bytes or block an independently admitted sibling.
          if (identityIssue !== null) return { ranges: [], identityIssue };
          if (!admission.ok)
            throw formatFailure(`Node SEA ${admission.error.message}`);
          const { issue } = machoSectionBacking(record, segment);
          if (issue !== null)
            throw formatFailure(`Mach-O Node SEA section ${issue}`);
          const fileOffset = record.offset;
          // The segment and section bounds admit every nonempty payload.
          // Empty segments can still declare an offset outside the image.
          if (fileOffset > sliceSize)
            throw truncatedFailure(NODE_SEA_TRUNCATED);
          const length = Number(record.size);
          admitBlobBytes(carrier, length);
          found.push({ offset: base + fileOffset, length });
        }
      }
    }
  }
  if (found.length > 0 && !cursor.finish().ok)
    throw truncatedFailure(NODE_SEA_MACHO_COMMANDS_TRUNCATED);
  return { ranges: found };
};

const locateElfNotes = async (
  carrier: Carrier,
  prefix: Buffer,
): Promise<BlobRange[]> => {
  const header = readElfFixedHeader(prefix, carrier.fileSize);
  if (!header.ok) return [];
  const little = header.value.byteOrder === "little";
  const { elfClass } = header.value;
  const fields = await readExact(
    carrier,
    0,
    Math.min(carrier.fileSize, header.value.headerSize),
  );
  if (fields === undefined) return [];
  const raw = readElfRawTableDeclarations(fields, header.value);
  if (!raw.ok) return [];
  const { programs: programDeclarations, sections: sectionDeclarations } =
    raw.value;
  const phoff =
    programDeclarations.offset <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(programDeclarations.offset)
      : undefined;
  const shoff =
    sectionDeclarations.offset <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(sectionDeclarations.offset)
      : undefined;
  const phentsize = programDeclarations.width;
  const phnum = programDeclarations.count;
  const shentsize = sectionDeclarations.width;
  const shnum = sectionDeclarations.count;
  const found: BlobRange[] = [];
  let opaque: string | undefined;
  // Each note header takes at least 12 file bytes. The containing program or
  // section header also makes room in this allowance for one short tail read.
  // Overlapping declarations must not repeatedly scan the same bytes.
  const scan: NoteScan = {
    little,
    frames: Math.floor(carrier.fileSize / ELF_NOTE_HEADER_BYTES),
  };
  const programs = await readElfTables(carrier, {
    offset: phoff,
    count: phnum,
    entrySize: phentsize,
    minimumEntry: elfProgramHeaderWidth(elfClass),
  });
  if (programs === undefined && phnum > 0)
    opaque = NODE_SEA_ELF_TABLE_TRUNCATED;
  if (programs !== undefined)
    for (const entry of programs) {
      const parsedProgram = readElfProgramHeader(
        entry,
        header.value.elfClass,
        little,
      );
      if (!parsedProgram.ok) continue;
      const program = parsedProgram.value;
      if (program.type !== PT_NOTE) continue;
      const note = {
        offset:
          program.offset <= BigInt(Number.MAX_SAFE_INTEGER)
            ? Number(program.offset)
            : undefined,
        length:
          program.fileSize <= BigInt(Number.MAX_SAFE_INTEGER)
            ? Number(program.fileSize)
            : undefined,
        align:
          program.alignment <= BigInt(Number.MAX_SAFE_INTEGER)
            ? Number(program.alignment)
            : undefined,
      };
      const scanned = await scanElfNoteTable(
        carrier,
        note,
        scan,
        found.length > 0,
      );
      if (scanned === undefined) opaque ??= NODE_SEA_ELF_TABLE_TRUNCATED;
      else for (const range of scanned) found.push(range);
    }
  // The runtime locates the blob through PT_NOTE segments. Injectors can
  // leave stale or misaligned SHT_NOTE entries, so section notes are only a
  // fallback when no program-header table is readable.
  if (programs !== undefined && phnum > 0) {
    if (found.length > 0 && opaque !== undefined) throw formatFailure(opaque);
    return found;
  }
  // A malformed section declaration cannot supply a fallback note location.
  if (!validateElfSectionTableFields(raw.value).ok) return [];
  const sections = await readElfTables(carrier, {
    offset: shoff,
    count: shnum,
    entrySize: shentsize,
    minimumEntry: elfSectionHeaderWidth(elfClass),
  });
  if (sections === undefined && shnum > 0)
    opaque ??= NODE_SEA_ELF_TABLE_TRUNCATED;
  if (sections !== undefined)
    for (const entry of sections) {
      const parsedSection = readElfSectionHeader(
        entry,
        header.value.elfClass,
        little,
      );
      if (!parsedSection.ok) continue;
      const section = parsedSection.value;
      const storage = elfNoteSectionStorage(section);
      if (storage === "not-note") continue;
      if (storage === "compressed") {
        opaque ??=
          "Compressed ELF note sections cannot establish raw Node SEA blob offsets";
        continue;
      }
      const note = {
        offset:
          section.offset <= BigInt(Number.MAX_SAFE_INTEGER)
            ? Number(section.offset)
            : undefined,
        length:
          section.size <= BigInt(Number.MAX_SAFE_INTEGER)
            ? Number(section.size)
            : undefined,
        align:
          section.alignment <= BigInt(Number.MAX_SAFE_INTEGER)
            ? Number(section.alignment)
            : undefined,
      };
      const scanned = await scanElfNoteTable(
        carrier,
        note,
        scan,
        found.length > 0,
      );
      if (scanned === undefined) opaque ??= NODE_SEA_ELF_TABLE_TRUNCATED;
      else for (const range of scanned) found.push(range);
    }
  if (found.length > 0 && opaque !== undefined) throw formatFailure(opaque);
  return found;
};

const readElfTables = async (
  carrier: Carrier,
  table: {
    readonly offset: number | undefined;
    readonly count: number;
    readonly entrySize: number;
    readonly minimumEntry: number;
  },
): Promise<Buffer[] | undefined> => {
  if (table.count === 0) return [];
  if (
    table.offset === undefined ||
    table.entrySize < table.minimumEntry ||
    table.offset > carrier.fileSize ||
    table.count >
      Math.floor((carrier.fileSize - table.offset) / table.entrySize)
  )
    return undefined;
  const limits = carrier.limits ?? DEFAULT_NODE_SEA_READER_LIMITS;
  if (table.count > limits.recognition_header_count)
    throw artifactReaderLimitFailure(
      "artifact_limits.node_sea.recognition_header_count",
      limits.recognition_header_count,
      "count",
      table.count,
    );
  const entries: Buffer[] = [];
  for (let index = 0; index < table.count; index += 1) {
    if (index % 128 === 0) abortIfNeeded(carrier.signal);
    const offset = table.offset + index * table.entrySize;
    if (
      offset > carrier.fileSize ||
      table.minimumEntry > carrier.fileSize - offset
    )
      return undefined;
    const entry = await readExact(carrier, offset, table.minimumEntry);
    if (entry === undefined) return undefined;
    entries.push(entry);
  }
  return entries;
};

/** One carrier's note byte order and the framing reads it may still perform. */
interface NoteScan {
  readonly little: boolean;
  frames: number;
}

const chargeNoteFrame = (scan: NoteScan, confirmed: boolean): boolean => {
  if (scan.frames === 0) {
    if (confirmed) throw formatFailure(NODE_SEA_ELF_NOTES_REPEATED);
    return false;
  }
  scan.frames -= 1;
  return true;
};

const scanElfNoteTable = async (
  carrier: Carrier,
  note: {
    readonly offset: number | undefined;
    readonly length: number | undefined;
    readonly align: number | undefined;
  },
  scan: NoteScan,
  alreadyFound: boolean,
): Promise<BlobRange[] | undefined> => {
  if (
    note.offset === undefined ||
    note.length === undefined ||
    note.offset > carrier.fileSize ||
    note.length > carrier.fileSize - note.offset
  )
    return undefined;
  const alignment = elfNoteAlignment(note.align === 8 ? 8 : 4);
  const found: BlobRange[] = [];
  let cursor = 0;
  while (cursor + ELF_NOTE_HEADER_BYTES <= note.length) {
    abortIfNeeded(carrier.signal);
    if (!chargeNoteFrame(scan, alreadyFound || found.length > 0))
      return undefined;
    const header = await readExact(
      carrier,
      note.offset + cursor,
      ELF_NOTE_HEADER_BYTES,
    );
    if (header === undefined)
      return failNoteTable(alreadyFound || found.length > 0);
    const frame = readElfNoteFrame(
      header,
      scan.little,
      alignment,
      note.length - cursor,
    );
    if (!frame.ok || frame.value.framing === "truncated-name")
      return failNoteTable(alreadyFound || found.length > 0);
    const { namesz, descsz, descriptor, next, framing } = frame.value;
    // Only the exact SEA owner matters here. A bounded prefix distinguishes
    // it without retaining an unrelated vendor's potentially long name.
    const name = await readExact(
      carrier,
      note.offset + cursor + ELF_NOTE_HEADER_BYTES,
      Math.min(namesz, RESOURCE_NAME.length + 1),
    );
    if (name === undefined)
      return failNoteTable(alreadyFound || found.length > 0);
    const owner = cString(name, 0, name.length);
    if (owner === RESOURCE_NAME) {
      if (framing === "truncated-descriptor")
        throw truncatedFailure(NODE_SEA_ELF_DESCRIPTOR_TRUNCATED);
      admitBlobBytes(carrier, descsz);
      found.push({ offset: note.offset + cursor + descriptor, length: descsz });
    }
    if (framing !== "complete")
      return failNoteTable(alreadyFound || found.length > 0);
    cursor += next;
  }
  if (cursor < note.length) {
    const confirmed = alreadyFound || found.length > 0;
    if (!chargeNoteFrame(scan, confirmed)) return undefined;
    const tail = await readExact(
      carrier,
      note.offset + cursor,
      note.length - cursor,
    );
    if (tail === undefined) return failNoteTable(confirmed);
    if (!isElfNotePadding(tail))
      return failNoteTable(
        confirmed,
        "ELF note table has trailing non-zero bytes",
      );
  }
  return found;
};

const failNoteTable = (
  confirmed: boolean,
  detail = NODE_SEA_ELF_TABLE_TRUNCATED,
): undefined => {
  if (confirmed) throw formatFailure(detail);
  return undefined;
};

const locatePeResources = async (
  carrier: Carrier,
  prefix: Buffer,
): Promise<BlobRange[]> => {
  // Probe for the NODE_SEA_BLOB name first so a malformed resource tree in an
  // ordinary PE stays a native-classification concern, not a SEA failure.
  if (
    !(await hasPeResourceName(
      prefix,
      carrier.fileSize,
      (offset, length) => readExact(carrier, offset, length),
      RT_RCDATA,
      RESOURCE_NAME,
      MAX_INSPECT_PE_DIRECTORY_ENTRIES,
    ))
  )
    return [];
  if (carrier.fileSize > MAX_INSPECT_PE_FILE_BYTES) {
    throw limitFailure(
      "Node SEA PE inspection exceeds the 512 MiB PE parser input ceiling",
    );
  }
  const bytes = await readExact(carrier, 0, carrier.fileSize);
  if (bytes === undefined) throw truncatedFailure(NODE_SEA_TRUNCATED);
  // A native-looking file need not be an admitted PE image. Once the layout
  // is admitted, resource errors remain failures rather than inferred absence.
  let layout: ReturnType<typeof readPeResourceLayout>;
  try {
    layout = readPeResourceLayout(bytes);
  } catch (cause) {
    if (cause instanceof ParseFailureError && cause.kind === "malformed")
      return [];
    throw cause;
  }
  let resources: Awaited<ReturnType<typeof readPeResourceEntries>>;
  try {
    resources = await readPeResourceEntries(
      bytes,
      layout,
      MAX_INSPECT_PE_DIRECTORY_ENTRIES,
      carrier.signal,
    );
  } catch (cause) {
    throw artifactParseFailure(cause, carrier.signal, peResourceLimitBoundary);
  }
  return resources.flatMap((resource) => {
    if (
      resource.type.kind !== "id" ||
      resource.type.id !== RT_RCDATA ||
      resource.name.kind !== "name" ||
      resource.name.name !== RESOURCE_NAME
    )
      return [];
    const range = resource.payload.location;
    admitBlobBytes(carrier, range.bytes);
    return [{ offset: range.offset, length: range.bytes }];
  });
};

const cString = (bytes: Buffer, offset: number, length: number): string => {
  let end = offset;
  const limit = Math.min(bytes.length, offset + length);
  while (end < limit && bytes[end] !== 0) end += 1;
  return bytes.toString("latin1", offset, end);
};
