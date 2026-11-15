import { malformedInput, truncatedInput } from "../domain/parseFailure.js";
import { LC } from "../domain/apple/machoLoadCommandCodes.js";
import type {
  FileMapping,
  ZeroFillMapping,
} from "../domain/virtualFileMapping.js";
import {
  machoDependencyCommand,
  readMachoDylibCommandFacts,
} from "../domain/apple/machoDylibCommand.js";
import { readMachoSectionHeader } from "../domain/apple/machoSectionHeader.js";
import {
  admitMachoSegmentMapping,
  readMachoSegmentHeader,
} from "../domain/apple/machoSegmentHeader.js";
import {
  MachoLoadCommandCursor,
  readMachoLoadCommandDeclarations,
} from "../domain/apple/machoLoadCommands.js";
import { createHash } from "node:crypto";
import {
  BinaryFormatFailure,
  createFileMappingIndex,
} from "./metadata/BinaryContainer.js";

import type { FixupCommands } from "./AppleMachoFixups.js";
import { decodeMachoFixedName, decodeMachoName } from "./AppleMachoNames.js";
import { MACHO_ARCHITECTURE_POLICIES } from "./MachoArchitectureSelection.js";
import {
  readFatSliceDeclarations,
  readFatHeaderPrefix,
  validateFatSlice,
  validateFatSliceIdentity,
  type FatSliceDeclaration,
} from "../domain/apple/machoContainer.js";

/** One mapped Mach-O segment with file-backed VA range. */
export interface Segment {
  address: bigint;
  size: bigint;
  offset: number;
  executable: boolean;
}

/** Named Mach-O section within a loaded segment. */
export interface Section {
  name: string;
  address: bigint;
  size: number;
}

/** Selected thin slice bounds inside a Mach-O or FAT container. */
export interface MachoSlice {
  slice: number;
  sliceEnd: number;
  /** FAT table identity, absent for a thin image. */
  fatDeclaration?: FatSliceDeclaration & { readonly tableEnd: number };
}

/** Parsed little-endian 64-bit Mach-O layout for the selected architecture slice. */
export interface MachoLayout {
  segments: Segment[];
  sections: Section[];
  /** CPU identity and exact byte range selected from this source artifact. */
  selectedImage: {
    readonly container: "thin" | "fat";
    readonly offset: number;
    readonly byteLength: number;
    readonly cpuType: number;
    readonly cpuSubtype: number;
    readonly containerTableSha256: string | null;
  };
  /** Fixup load commands and dependent dylibs of the selected slice. */
  fixups: FixupCommands;
  /** VM address of the segment that maps file offset 0 (the preferred load address). */
  baseAddress: bigint;
  /** Map a virtual address range onto a file offset within the selected slice. */
  offset(address: bigint, size?: number): number;
}

const hex = (value: bigint) => `0x${value.toString(16)}`;

/** File range admission already chose. Metadata must not rank slices again. */
export interface AdmittedMachoSlice {
  readonly offset: number;
  readonly size: number;
}

/**
 * Locate the thin Mach-O image to read. A thin image is read whole; a
 * universal image only at the slice target admission selected, whose
 * declaration and CPU family this reader validates.
 */
export const selectMachoSlice = (
  bytes: Buffer,
  architecture: string,
  admitted?: AdmittedMachoSlice,
): MachoSlice => {
  const header = readFatHeaderPrefix(bytes);
  if (header.state === "unknown")
    throw truncatedInput("macho", "Truncated Mach-O header");
  if (header.state === "not-fat") return { slice: 0, sliceEnd: bytes.length };
  const { littleEndian, wide } = header;
  const byteOrder = littleEndian ? "little-endian" : "big-endian";
  const malformed = (reason: string) =>
    malformedInput("macho", `${reason} (FAT header byte order: ${byteOrder})`);
  const invalid = (reason: string) =>
    new TypeError(`${reason} (FAT header byte order: ${byteOrder})`);
  if (header.state === "incomplete")
    throw malformed("Malformed FAT architecture table");
  const { count, tableEnd: headerEnd } = header;
  if (count > 128 || headerEnd > bytes.length)
    throw malformed("Malformed FAT architecture table");
  const policy = MACHO_ARCHITECTURE_POLICIES[architecture];
  if (policy === undefined)
    throw invalid("Requested FAT architecture is absent");
  const declarations = readFatSliceDeclarations(bytes.subarray(8, headerEnd), {
    count,
    wide,
    littleEndian,
  });
  if (declarations.status !== "parsed") throw malformed(declarations.reason);
  // Target admission owns slice choice; ranking here again could read a
  // different slice than the one the session's Evidence names.
  if (admitted === undefined)
    throw invalid("Universal Mach-O metadata needs the admitted slice");
  const matches = declarations.slices.filter(
    (declaration) =>
      declaration.offset === admitted.offset &&
      declaration.size === admitted.size,
  );
  const [match] = matches;
  if (match === undefined) throw invalid("Admitted FAT slice is not declared");
  if (matches.length > 1)
    throw malformed("Admitted FAT slice is declared more than once");
  if (match.cpuType !== policy.cpuType)
    throw invalid(
      "Admitted FAT slice does not match the requested architecture",
    );
  const issue = validateFatSlice(match, bytes.length, headerEnd);
  if (issue !== null) throw malformed(issue);
  return {
    slice: match.offset,
    sliceEnd: match.offset + match.size,
    fatDeclaration: { ...match, tableEnd: headerEnd },
  };
};

/** Parse segments/sections for a little-endian 64-bit Mach-O architecture slice. */
export const parseMachoLayout = (
  bytes: Buffer,
  architecture: string,
  admitted?: AdmittedMachoSlice,
): MachoLayout => {
  if (bytes.length < 4)
    throw truncatedInput("macho", "Truncated Mach-O header");
  const selection = selectMachoSlice(bytes, architecture, admitted);
  const { slice, sliceEnd } = selection;
  if (slice + 4 > sliceEnd)
    throw truncatedInput("macho", "Truncated Mach-O header");
  const selectedBytes = bytes.subarray(slice, sliceEnd);
  const declarations = readMachoLoadCommandDeclarations(
    selectedBytes,
    selectedBytes.length,
  );
  if (!declarations.ok)
    throw truncatedInput("macho", "Truncated Mach-O header");
  if (declarations.value === null) {
    if (selectedBytes.length < 32)
      throw truncatedInput("macho", "Truncated Mach-O header");
    throw new TypeError(
      "Only little-endian 64-bit Mach-O metadata is supported",
    );
  }
  const table = declarations.value;
  const { cpuType, cpuSubtype } = table.identity;
  const fat = selection.fatDeclaration;
  if (fat !== undefined) {
    const issue = validateFatSliceIdentity(fat, {
      cpuType,
      cpuSubtype,
    });
    if (issue !== null) throw new TypeError(issue);
  }
  if (table.wide && !table.littleEndian) {
    if (cpuType !== 0x01000012)
      throw new BinaryFormatFailure(
        "unsupported",
        "Unsupported big-endian Mach-O CPU type",
      );
    throw new BinaryFormatFailure(
      "unsupported",
      "Unsupported big-endian 64-bit PowerPC Mach-O metadata",
      {
        format: "macho",
        undecodedContent: true,
      },
    );
  }
  // A thin image has no FAT declaration to bind the requested CPU family.
  // Admit its parsed header before consumers attach the caller's architecture.
  if (MACHO_ARCHITECTURE_POLICIES[architecture]?.cpuType !== cpuType)
    throw new TypeError(
      `Mach-O CPU type does not match requested architecture ${architecture}`,
    );
  if (!table.wide)
    throw new BinaryFormatFailure(
      "unsupported",
      `Unsupported 32-bit Mach-O metadata for requested CPU type ${architecture}`,
      {
        format: "macho",
        undecodedContent: true,
      },
    );
  const commandEnd = slice + table.headerSize + table.commandBytes;
  if (commandEnd > sliceEnd)
    throw malformedInput("macho", "Malformed Mach-O command bounds");
  const state: LayoutState = {
    slice,
    sliceEnd,
    segments: [],
    mappings: [],
    zeroFills: [],
    sections: [],
    dylibs: [],
    binds: [],
    rebases: [],
    chained: null,
    dyldInfo: false,
    baseAddress: undefined,
  };
  const framing = new MachoLoadCommandCursor(table);
  while (framing.nextOffset !== null) {
    const cursor = slice + table.headerSize + framing.nextOffset;
    const frame = framing.read(bytes.subarray(cursor, cursor + 8));
    if (!frame.ok) throw malformedInput("macho", frame.error);
    const command = {
      cursor,
      kind: frame.value.command,
      size: frame.value.size,
    };
    if (command.kind === LC.SEGMENT)
      throw malformedInput(
        "macho",
        "Mach-O segment command does not match the header width",
      );
    if (command.kind === LC.SEGMENT_64) collectSegment(bytes, command, state);
    else collectFixupCommand(bytes, command, state);
  }
  const complete = framing.finish();
  if (!complete.ok) throw malformedInput("macho", complete.error);
  const { segments, sections, chained, binds, rebases, dylibs } = state;
  const mappings = createFileMappingIndex(state.mappings, state.zeroFills);
  const offset = (address: bigint, size = 1): number => {
    try {
      return mappings.offset(address, size);
    } catch (cause) {
      // Metadata consumers retain partial facts when a pointer is unavailable.
      // Mapping interpretation belongs to the shared image reader, including
      // aliases that only overlap part of the span.
      if (!(cause instanceof BinaryFormatFailure)) throw cause;
      throw malformedInput(
        "macho",
        `Unmapped or ambiguous metadata pointer ${hex(address)}`,
        { cause },
      );
    }
  };
  return {
    segments,
    sections,
    selectedImage: {
      container: fat === undefined ? "thin" : "fat",
      offset: slice,
      byteLength: sliceEnd - slice,
      cpuType,
      cpuSubtype,
      containerTableSha256:
        fat === undefined
          ? null
          : createHash("sha256")
              .update(bytes.subarray(0, fat.tableEnd))
              .digest("hex"),
    },
    offset,
    fixups: { chained, binds, rebases, dylibs },
    baseAddress: state.baseAddress ?? 0n,
  };
};

/** Load commands and fixup ranges collected while walking one slice. */
interface LayoutState {
  readonly slice: number;
  readonly sliceEnd: number;
  readonly segments: Segment[];
  readonly mappings: FileMapping[];
  readonly zeroFills: ZeroFillMapping[];
  readonly sections: Section[];
  readonly dylibs: FixupCommands["dylibs"][number][];
  readonly binds: FixupCommands["binds"][number][];
  readonly rebases: FixupCommands["rebases"][number][];
  chained: FixupCommands["chained"];
  /** Whether an LC_DYLD_INFO or LC_DYLD_INFO_ONLY command was read. */
  dyldInfo: boolean;
  baseAddress: bigint | undefined;
}

/** One load command header inside the selected slice. */
interface LoadCommand {
  readonly cursor: number;
  readonly kind: number;
  readonly size: number;
}

/** Record an `LC_SEGMENT_64` and its section table. */
const collectSegment = (
  bytes: Buffer,
  { cursor, size }: LoadCommand,
  state: LayoutState,
): void => {
  const parsed = readMachoSegmentHeader(
    bytes.subarray(cursor, cursor + size),
    true,
    true,
  );
  if (!parsed.ok) throw truncatedInput("macho", "Truncated segment command");
  const {
    address,
    memorySize,
    nameBytes,
    fileSize,
    fileOffset,
    protection,
    sectionCount: count,
    headerSize,
  } = parsed.value;
  const admitted = admitMachoSegmentMapping(parsed.value, 64);
  if (!admitted.ok) throw malformedInput("macho", admitted.error.message);
  if (fileOffset + fileSize > BigInt(state.sliceEnd - state.slice))
    throw malformedInput("macho", "Segment file range exceeds target bytes");
  const name = decodeMachoFixedName(nameBytes);
  state.segments.push({
    address,
    size: fileSize,
    offset: state.slice + Number(fileOffset),
    executable: (protection & 4) !== 0,
  });
  if (!admitted.value.unmapped && name !== "__PAGEZERO")
    state.mappings.push({
      address,
      size: Number(fileSize),
      offset: state.slice + Number(fileOffset),
    });
  if (memorySize > fileSize && name !== "__PAGEZERO")
    state.zeroFills.push({
      address: address + fileSize,
      size: memorySize - fileSize,
    });
  if (
    !admitted.value.unmapped &&
    name !== "__PAGEZERO" &&
    fileOffset === 0n &&
    fileSize > 0n
  )
    state.baseAddress ??= address;
  if (headerSize + count * 80 > size)
    throw truncatedInput("macho", "Truncated section table");
  for (let section = 0; section < count; section++) {
    const position = cursor + headerSize + section * 80;
    const parsedSection = readMachoSectionHeader(
      bytes.subarray(position, position + 80),
      true,
      true,
    );
    if (!parsedSection.ok)
      throw truncatedInput("macho", "Truncated section table");
    const { nameBytes, address, size: sectionSize } = parsedSection.value;
    if (sectionSize > BigInt(Number.MAX_SAFE_INTEGER))
      throw malformedInput("macho", "Section size exceeds exact numeric range");
    state.sections.push({
      name: decodeMachoFixedName(nameBytes),
      address,
      size: Number(sectionSize),
    });
  }
};

/** Record fixup data ranges and dylib install names from one load command. */
const collectFixupCommand = (
  bytes: Buffer,
  { cursor, kind, size }: LoadCommand,
  state: LayoutState,
): void => {
  const range = (at: number): { offset: number; size: number } => {
    const offset = state.slice + bytes.readUInt32LE(at);
    const length = bytes.readUInt32LE(at + 4);
    if (offset + length > state.sliceEnd)
      throw malformedInput("macho", "Fixup data exceeds the Mach-O slice");
    return { offset, size: length };
  };
  // An image has one fixup table of each kind; with a repeat, neither table
  // is the image's, so the slice is refused rather than read by position.
  if (kind === LC.DYLD_CHAINED_FIXUPS) {
    if (size < 16)
      throw truncatedInput("macho", "Truncated chained-fixups command");
    if (state.chained !== null)
      throw malformedInput(
        "macho",
        "Mach-O slice declares more than one LC_DYLD_CHAINED_FIXUPS command",
      );
    state.chained = range(cursor + 8);
  } else if (kind === LC.DYLD_INFO || kind === LC.DYLD_INFO_ONLY) {
    if (size < 48) throw truncatedInput("macho", "Truncated dyld-info command");
    if (state.dyldInfo)
      throw malformedInput(
        "macho",
        "Mach-O slice declares more than one LC_DYLD_INFO or LC_DYLD_INFO_ONLY command",
      );
    state.dyldInfo = true;
    const rebase = range(cursor + 8);
    if (rebase.size > 0) state.rebases.push(rebase);
    for (const [at, stream] of [
      [cursor + 16, "bind"],
      [cursor + 24, "weak"],
      [cursor + 32, "lazy"],
    ] as const) {
      const bound = range(at);
      if (bound.size > 0) state.binds.push({ ...bound, stream });
    }
  } else if (machoDependencyCommand(kind) !== null) {
    const parsed = readMachoDylibCommandFacts(
      bytes.subarray(cursor, cursor + size),
      true,
    );
    if (!parsed.ok) {
      if (parsed.error._tag === "InvalidMachoDylibCommand")
        throw truncatedInput("macho", "Truncated dylib command");
      if (parsed.error.reason === "unterminated")
        throw truncatedInput("macho", "Unterminated dylib install name");
      throw malformedInput(
        "macho",
        "Dylib install name is outside its load command",
      );
    }
    const { nameBytes } = parsed.value;
    state.dylibs.push(
      decodeMachoName(
        Buffer.from(
          nameBytes.buffer,
          nameBytes.byteOffset,
          nameBytes.byteLength,
        ),
      ),
    );
  }
};
