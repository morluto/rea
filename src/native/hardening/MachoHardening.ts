import { LC } from "../../domain/apple/machoLoadCommandCodes.js";
import { validateFatSliceIdentity } from "../../domain/apple/machoContainer.js";
import {
  machoArchitectureName,
  machoKnownArm64Subtype,
} from "../../domain/apple/machoCpuIdentity.js";
import {
  admitMachoSymtabRanges,
  MACHO_HEADER_FLAGS_OFFSET,
  readMachoLinkeditDataCommand,
  readMachoSymtabCommand,
} from "../../domain/apple/machoLoadCommands.js";
import type { MachoSliceEncryption } from "../../domain/apple/machoEncryption.js";
import {
  admitMachoSectionPayload,
  readMachoSectionHeader,
} from "../../domain/apple/machoSectionHeader.js";
import {
  admitMachoSegmentCommand,
  readMachoSegmentHeader,
} from "../../domain/apple/machoSegmentHeader.js";
import { machoBinaryArchitecture } from "../../domain/binaryTarget.js";
import { decodeMachoFixedName } from "../../domain/apple/appleMachoNames.js";
import {
  elfStringTableText,
  observeElfStringTableWindow,
} from "../../domain/elfStringTable.js";
import {
  type BinaryHardeningImage,
  type BinaryHardeningRow,
  type BinaryHardeningSlice,
  MACHO_HARDENING_PROPERTIES,
  MAX_BINARY_HARDENING_SYMBOL_NAME_BYTES,
  MAX_BINARY_HARDENING_SYMBOL_SCAN_BYTES,
  MAX_BINARY_HARDENING_TABLE_ENTRIES,
} from "../../domain/native/binaryHardening.js";
import { assertArtifactReadActive } from "../../resources/index.js";
import {
  BinaryFormatFailure,
  BinaryReader,
} from "../../domain/binaryContainer.js";
import { readMachoEncryption } from "../../domain/apple/machoEncryptionReader.js";
import {
  frameLoadCommands,
  readMachoContainer,
  readSliceCommandTable,
  type MachoLoadCommand,
  type MachoSliceHeader,
  type ReadAt,
} from "../../domain/apple/machoLoadCommandReader.js";
import type { ByteSource } from "../../domain/byteSource.js";

const STREAM_WINDOW_BYTES = 65536;

const MH_EXECUTE = 0x2;
const MH_DYLIB = 0x6;
const MH_BUNDLE = 0x8;
const MH_ALLOW_STACK_EXECUTION = 0x20000;
const MH_PIE = 0x200000;
const MH_NO_HEAP_EXECUTION = 0x1000000;
const CPU_TYPE_ARM64 = 0x0100000c;
const MAPPING_BUDGET = 4096;

function malformed(message: string): never {
  throw new BinaryFormatFailure("malformed", message);
}

const row = (
  property: BinaryHardeningRow["property"],
  state: BinaryHardeningRow["state"],
  basis: string,
  location: BinaryHardeningRow["location"] = null,
  note: string | null = null,
  nextProbe: string | null = null,
): BinaryHardeningRow => ({
  property,
  state,
  confidence: "observed",
  basis,
  location,
  note,
  next_probe: nextProbe,
});

type SliceRef = {
  readonly thin: boolean;
  readonly index: number;
  readonly offset: number;
  readonly size: number;
  readonly cpuType: number;
  readonly cpuSubtype: number;
  readonly rangeIssue: {
    readonly status: "malformed" | "unknown";
    readonly reason: string;
  } | null;
};

/** Read Mach-O hardening per slice. One slice's defect leaves the others intact. */
export const readMachoHardening = async (
  bytes: Buffer,
  signal?: AbortSignal,
): Promise<BinaryHardeningImage[]> => {
  assertArtifactReadActive(signal);
  const readAt: ReadAt = async (offset, length) => {
    assertArtifactReadActive(signal);
    if (offset < 0 || length < 0 || offset > bytes.length)
      return Buffer.alloc(0);
    return bytes.subarray(offset, Math.min(bytes.length, offset + length));
  };
  return readMachoHardeningFromReader(readAt, bytes.length, signal);
};

/** Same Mach-O hardening read over a random-access handle without buffering the full image. */
export const readMachoHardeningFromHandle = async (
  source: ByteSource,
  signal?: AbortSignal,
): Promise<BinaryHardeningImage[]> => {
  assertArtifactReadActive(signal);
  const readAt: ReadAt = async (offset, length) => {
    assertArtifactReadActive(signal);
    if (offset < 0 || length <= 0 || offset >= source.size)
      return Buffer.alloc(0);
    const clamped = Math.min(length, source.size - offset);
    if (source.prefix !== undefined && offset + clamped <= source.prefix.length)
      return source.prefix.subarray(offset, offset + clamped);
    return source.readRange(offset, clamped);
  };
  return readMachoHardeningFromReader(readAt, source.size, signal);
};

const readMachoHardeningFromReader = async (
  readAt: ReadAt,
  fileSize: number,
  signal?: AbortSignal,
): Promise<BinaryHardeningImage[]> => {
  const container = await readMachoContainer(readAt, fileSize);
  if (container.kind === "not-mach-o")
    throw new BinaryFormatFailure(
      "unsupported",
      "File is not ELF, PE, or Mach-O",
    );
  if (container.kind === "issue")
    throw new BinaryFormatFailure(container.status, container.reason);
  if (
    container.kind === "fat" &&
    container.hidden !== null &&
    container.hidden.status !== "declared"
  )
    throw new BinaryFormatFailure(
      container.hidden.status,
      container.hidden.reason,
    );
  const refs = sliceRefs(container, fileSize);
  const encryption = await readMachoEncryption(
    readAt,
    fileSize,
    MAPPING_BUDGET,
  );
  if (encryption.status === "not-mach-o")
    throw new BinaryFormatFailure(
      "unsupported",
      "File is not ELF, PE, or Mach-O",
    );
  if (encryption.status !== "parsed")
    throw new BinaryFormatFailure(encryption.status, encryption.reason);
  if (encryption.slices.length !== refs.length)
    malformed("Mach-O encryption slice coverage disagrees with the container");
  const images: BinaryHardeningImage[] = [];
  for (const [index, ref] of refs.entries()) {
    const encrypted = encryption.slices[index];
    if (
      encrypted === undefined ||
      encrypted.container_file_offset !== ref.offset
    )
      malformed("Mach-O encryption slice order disagrees with the container");
    assertArtifactReadActive(signal);
    images.push(await readSliceImage(readAt, fileSize, ref, encrypted));
  }
  return images;
};

const sliceRefs = (
  container: Exclude<
    Awaited<ReturnType<typeof readMachoContainer>>,
    { kind: "not-mach-o" | "issue" }
  >,
  size: number,
): SliceRef[] => {
  if (container.kind === "thin")
    return [
      {
        thin: true,
        index: 0,
        offset: 0,
        size,
        cpuType: 0,
        cpuSubtype: 0,
        rangeIssue: null,
      },
    ];
  const refs: SliceRef[] = container.header.slices.map((declaration, index) => {
    const issue = container.header.rangeIssues[index] ?? null;
    return {
      thin: false,
      index: declaration.index,
      offset: declaration.offset,
      size: declaration.size,
      cpuType: declaration.cpuType,
      cpuSubtype: declaration.cpuSubtype,
      rangeIssue:
        issue === null
          ? null
          : {
              status:
                issue.category === "unsupported" ? "unknown" : "malformed",
              reason: issue.reason,
            },
    };
  });
  const hidden = container.hidden;
  if (hidden !== null && hidden.status === "declared")
    refs.push({
      thin: false,
      index: hidden.declaration.index,
      offset: hidden.declaration.offset,
      size: hidden.declaration.size,
      cpuType: hidden.declaration.cpuType,
      cpuSubtype: hidden.declaration.cpuSubtype,
      rangeIssue:
        hidden.rangeIssue === null
          ? null
          : { status: "malformed", reason: hidden.rangeIssue },
    });
  return refs;
};

const sliceRecord = (
  ref: SliceRef,
  cpuType = ref.cpuType,
  cpuSubtype = ref.cpuSubtype,
): BinaryHardeningSlice => ({
  index: ref.index,
  file_offset: ref.offset,
  size: ref.size,
  cpu_type: cpuType,
  cpu_subtype: cpuSubtype,
  architecture: machoArchitectureName(cpuType, cpuSubtype),
});

const cpuFamily = (cpuType: number): BinaryHardeningImage["architecture"] =>
  machoBinaryArchitecture(cpuType) ?? null;

const failedImage = (
  ref: SliceRef,
  status: "malformed" | "unknown",
  reason: string,
  header: MachoSliceHeader | null = null,
): BinaryHardeningImage => ({
  format: "mach-o",
  status,
  reason,
  architecture: cpuFamily(header?.cpuType ?? ref.cpuType),
  bits: null,
  byte_order: header === null ? null : "little",
  machine: ref.thin ? null : ref.cpuType,
  slice: ref.thin ? null : sliceRecord(ref),
  rows: [],
});

const readSliceImage = async (
  readAt: ReadAt,
  fileSize: number,
  ref: SliceRef,
  encrypted: MachoSliceEncryption,
): Promise<BinaryHardeningImage> => {
  if (ref.rangeIssue !== null)
    return failedImage(ref, ref.rangeIssue.status, ref.rangeIssue.reason);
  const table = await readSliceCommandTable(readAt, ref.offset, ref.size);
  if (table.status !== "read") {
    // A thin image has no sibling slice. A bad header is a failed file.
    if (ref.thin)
      throw new BinaryFormatFailure(
        table.status === "unsupported" ? "unsupported" : "malformed",
        table.reason,
      );
    return failedImage(
      ref,
      table.status === "unsupported" ? "unknown" : "malformed",
      table.reason,
      table.header,
    );
  }
  const { header } = table;
  if (!ref.thin) {
    const identity = validateFatSliceIdentity(
      {
        index: ref.index,
        offset: ref.offset,
        size: ref.size,
        alignmentExponent: 0,
        cpuType: ref.cpuType,
        cpuSubtype: ref.cpuSubtype,
        reserved: null,
      },
      { cpuType: header.cpuType, cpuSubtype: header.cpuSubtype },
    );
    if (identity !== null)
      return failedImage(ref, "malformed", identity, header);
  }
  try {
    const facts = readCommandFacts(table, header.wide, ref.size);
    admitEncryption(encrypted);
    const rows = await buildRows(
      readAt,
      fileSize,
      ref,
      header,
      facts,
      encrypted,
    );
    return {
      format: "mach-o",
      status: "parsed",
      reason: null,
      architecture: cpuFamily(header.cpuType),
      bits: header.wide ? 64 : 32,
      byte_order: "little",
      machine: header.cpuType,
      slice: ref.thin
        ? null
        : sliceRecord(ref, header.cpuType, header.cpuSubtype),
      rows,
    };
  } catch (cause) {
    if (cause instanceof BinaryFormatFailure && cause.kind !== "unsupported") {
      if (ref.thin) throw cause;
      return failedImage(ref, "malformed", cause.message, header);
    }
    throw cause;
  }
};

/** Facts the rows need. A load command table can hold millions of small frames. */
type CommandFacts = {
  /** Table-relative offset of the first `__restrict` section header in a `__RESTRICT` segment. */
  restrict: number | null;
  /** Table-relative offset of the first `__RESTRICT` segment command. */
  restrictSegment: number | null;
  /** Table-relative offset of the first `LC_CODE_SIGNATURE` command. */
  signature: number | null;
  symtab: MachoLoadCommand | null;
};

/** Check every relevant command before any row exists, retaining only facts. */
const readCommandFacts = (
  table: Parameters<typeof frameLoadCommands>[0],
  wide: boolean,
  sliceSize: number,
): CommandFacts => {
  const facts: CommandFacts = {
    restrict: null,
    restrictSegment: null,
    signature: null,
    symtab: null,
  };
  const framed = frameLoadCommands(table, (command) => {
    const segment = readSegment(command, wide, sliceSize);
    if (segment?.name === "__RESTRICT") {
      facts.restrictSegment ??= command.offset;
      if (segment.restrictSection !== null)
        facts.restrict ??= command.offset + segment.restrictSection;
    }
    if (command.command === LC.CODE_SIGNATURE) {
      admitCodeSignature(command, sliceSize);
      facts.signature ??= command.offset;
    } else if (command.command === LC.SYMTAB) {
      if (facts.symtab !== null)
        malformed("Mach-O slice has more than one LC_SYMTAB");
      facts.symtab = command;
    }
  });
  if (framed.status !== "framed") malformed(framed.reason);
  return facts;
};

/**
 * The encryption reader reports every defect as a malformed slice status. Two
 * encryption commands are conflicting declarations and stay an `unknown` row.
 * Any other defect, such as a short command, a range past the slice, or the
 * wrong width, is structural and fails the slice before any row exists.
 */
const admitEncryption = (encrypted: MachoSliceEncryption): void => {
  if (
    encrypted.status === "malformed" &&
    encrypted.malformed_kind !== "duplicate-commands"
  )
    malformed(
      encrypted.reason ?? "Mach-O encryption load command is malformed",
    );
};

const admitCodeSignature = (
  { body, index }: MachoLoadCommand,
  sliceSize: number,
): void => {
  const data = readMachoLinkeditDataCommand(LC.CODE_SIGNATURE, body, true);
  if (data === null)
    return malformed(
      `load command ${index} is too short for LC_CODE_SIGNATURE`,
    );
  // Both fields are 32-bit, so their sum is a safe integer.
  if (data.dataOffset + data.dataSize > sliceSize)
    malformed(
      `load command ${index} LC_CODE_SIGNATURE data is outside the slice`,
    );
};

const buildRows = async (
  readAt: ReadAt,
  fileSize: number,
  ref: SliceRef,
  header: MachoSliceHeader,
  { restrict, restrictSegment, signature, symtab }: CommandFacts,
  encrypted: MachoSliceEncryption,
): Promise<BinaryHardeningRow[]> => {
  const flagLocation = {
    offset: ref.offset + MACHO_HEADER_FLAGS_OFFSET,
    bytes: 4,
  };
  const bit = (
    property: BinaryHardeningRow["property"],
    mask: number,
    name: string,
  ): BinaryHardeningRow => {
    const set = (header.flags & mask) !== 0;
    return row(
      property,
      set ? "enabled" : "disabled",
      `${name} is ${set ? "set" : "clear"}.`,
      flagLocation,
    );
  };
  const pie =
    header.fileType === MH_DYLIB || header.fileType === MH_BUNDLE
      ? row(
          "pie",
          "not_applicable",
          header.fileType === MH_DYLIB
            ? "MH_DYLIB images are position-independent and do not use MH_PIE."
            : "MH_BUNDLE images are position-independent and do not use MH_PIE.",
          flagLocation,
        )
      : header.fileType === MH_EXECUTE
        ? bit("pie", MH_PIE, "MH_PIE")
        : row(
            "pie",
            "not_applicable",
            `MH_PIE applies to MH_EXECUTE. This slice file type is ${String(header.fileType)}.`,
            flagLocation,
          );
  const rows = [
    pie,
    bit(
      "allow_stack_execution",
      MH_ALLOW_STACK_EXECUTION,
      "MH_ALLOW_STACK_EXECUTION",
    ),
    bit("no_heap_execution", MH_NO_HEAP_EXECUTION, "MH_NO_HEAP_EXECUTION"),
    // dyld restricts an image only for a __restrict section in a __RESTRICT segment.
    restrict !== null
      ? row(
          "restrict_segment",
          "enabled",
          "A __RESTRICT segment holds a __restrict section.",
          { offset: ref.offset + header.headerSize + restrict, bytes: 16 },
        )
      : restrictSegment !== null
        ? row(
            "restrict_segment",
            "disabled",
            "A __RESTRICT segment holds no __restrict section, which dyld requires.",
            {
              offset: ref.offset + header.headerSize + restrictSegment + 8,
              bytes: 16,
            },
          )
        : row(
            "restrict_segment",
            "disabled",
            "No __RESTRICT segment is present.",
          ),
    signature === null
      ? row(
          "code_signature_present",
          "disabled",
          "LC_CODE_SIGNATURE is absent.",
        )
      : row(
          "code_signature_present",
          "enabled",
          "LC_CODE_SIGNATURE is present. This is presence, not validity.",
          {
            offset: ref.offset + header.headerSize + signature,
            bytes: 16,
          },
        ),
    encryptionRow(encrypted),
    arm64Row(header.cpuType, header.cpuSubtype, ref.offset),
    await stackRow(readAt, fileSize, ref, header.wide, symtab),
    row(
      "hardened_runtime",
      "unknown",
      "CodeDirectory flags are not read here.",
      null,
      "inspect_signature owns Mach-O hardened runtime.",
      "inspect_signature",
    ),
  ];
  if (
    rows.map(({ property }) => property).join() !==
    MACHO_HARDENING_PROPERTIES.join()
  )
    malformed("Mach-O hardening rows are incomplete");
  return rows;
};

/** A segment's name and the command-relative offset of its first `__restrict` section header. */
const readSegment = (
  command: MachoLoadCommand,
  wide: boolean,
  sliceSize: number,
): { name: string; restrictSection: number | null } | null => {
  const expected = wide ? LC.SEGMENT_64 : LC.SEGMENT;
  if (command.command !== expected) {
    if (command.command === LC.SEGMENT || command.command === LC.SEGMENT_64)
      malformed("Mach-O segment command width does not match the slice header");
    return null;
  }
  const header = readMachoSegmentHeader(command.body, wide, true);
  if (!header.ok) malformed(header.error.message);
  // Segment file offsets are relative to the slice, not its container.
  const admitted = admitMachoSegmentCommand(
    header.value,
    command.body.byteLength,
    wide ? 64 : 32,
    sliceSize,
  );
  if (!admitted.ok) malformed(admitted.error.message);
  const sectionWidth = wide ? 80 : 68;
  let restrictSection: number | null = null;
  for (let index = 0; index < header.value.sectionCount; index += 1) {
    const at = header.value.headerSize + index * sectionWidth;
    const section = readMachoSectionHeader(
      command.body.subarray(at, at + sectionWidth),
      wide,
      true,
    );
    if (!section.ok) malformed(section.error.message);
    const payload = admitMachoSectionPayload(section.value, sliceSize);
    if (!payload.ok) malformed(payload.error.message);
    if (decodeMachoFixedName(section.value.nameBytes) === "__restrict")
      restrictSection ??= at;
  }
  // The fixed 16-byte name ends at the first NUL. Trailing-only stripping
  // would keep junk after an embedded NUL and miss __RESTRICT.
  return {
    name: decodeMachoFixedName(header.value.nameBytes),
    restrictSection,
  };
};

const unknownStackBudget = (
  reason = "The symbol table exceeds its structural budget, so this import sign is unknown.",
): BinaryHardeningRow =>
  row("stack_protector", "unknown", reason, null, reason);

const encryptionRow = (encrypted: MachoSliceEncryption): BinaryHardeningRow => {
  if (encrypted.status === "encrypted")
    return row(
      "encrypted",
      "enabled",
      "LC_ENCRYPTION_INFO cryptid is nonzero.",
    );
  if (encrypted.status === "not-encrypted")
    return row("encrypted", "disabled", "LC_ENCRYPTION_INFO cryptid is zero.");
  if (encrypted.status === "absent")
    return row(
      "encrypted",
      "disabled",
      "No LC_ENCRYPTION_INFO command is present.",
    );
  return row(
    "encrypted",
    "unknown",
    encrypted.reason ?? "Mach-O encryption state is unknown.",
    null,
    encrypted.reason,
  );
};

const arm64Row = (
  cpuType: number,
  cpuSubtype: number,
  sliceOffset: number,
): BinaryHardeningRow => {
  const location = { offset: sliceOffset + 8, bytes: 4 };
  if (cpuType !== CPU_TYPE_ARM64)
    return row(
      "arm64e",
      "not_applicable",
      `CPU type 0x${cpuType.toString(16)} is not ARM64.`,
      location,
    );
  const architecture = machoKnownArm64Subtype(cpuSubtype);
  if (architecture === undefined)
    return row(
      "arm64e",
      "unknown",
      `Unrecognized ARM64 CPU subtype 0x${(cpuSubtype >>> 0).toString(16)}; arm64e status is unknown.`,
      { offset: sliceOffset + 8, bytes: 4 },
    );
  const enabled = architecture === "arm64e" || architecture === "arm64e.x1";
  return row(
    "arm64e",
    enabled ? "enabled" : "disabled",
    `CPU subtype names this slice ${architecture}.`,
    location,
  );
};

const asBuffer = (bytes: Uint8Array): Buffer =>
  Buffer.isBuffer(bytes)
    ? bytes
    : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

const stackRow = async (
  readAt: ReadAt,
  fileSize: number,
  ref: SliceRef,
  wide: boolean,
  symtab: MachoLoadCommand | null,
): Promise<BinaryHardeningRow> => {
  if (symtab === null)
    return row(
      "stack_protector",
      "unknown",
      "LC_SYMTAB is absent, so stack protector use is unknown.",
      null,
      "LC_SYMTAB is absent, so stack protector use is unknown.",
    );
  const fields = readMachoSymtabCommand(symtab.body, true);
  if (fields === null) malformed("Mach-O LC_SYMTAB command is truncated");
  const { symoff, nsyms, stroff } = fields;
  const ranges = admitMachoSymtabRanges(fields, wide, ref.size);
  if (ranges === null)
    malformed("Mach-O symbol or string table extends outside the slice");
  const { width, symbolsEnd, stringsEnd } = ranges;
  if (symbolsEnd > fileSize - ref.offset || stringsEnd > fileSize - ref.offset)
    malformed("Mach-O symbol or string table extends outside the file");
  // Keep header rows and sibling slices when the backed table exceeds the scan limit.
  if (nsyms > MAX_BINARY_HARDENING_TABLE_ENTRIES) return unknownStackBudget();
  const stringAt = ref.offset + stroff;
  const stringSize = stringsEnd - stroff;
  const stringEnd = stringAt + stringSize;
  const symBase = ref.offset + symoff;
  const entriesPerChunk = Math.max(1, Math.floor(STREAM_WINDOW_BYTES / width));
  let symChunk: Buffer = Buffer.alloc(0);
  let symReader = new BinaryReader(symChunk, true, "macho");
  let symChunkFirst = 0;
  let symChunkCount = 0;
  let strWinBuf: Buffer = Buffer.alloc(0);
  let strWinStart = 0;
  let scanned = 0;
  let unterminated = false;
  let found: BinaryHardeningRow | null = null;
  for (let index = 0; index < nsyms; index += 1) {
    if (index < symChunkFirst || index >= symChunkFirst + symChunkCount) {
      const batch = Math.min(entriesPerChunk, nsyms - index);
      symChunk = asBuffer(await readAt(symBase + index * width, batch * width));
      symReader = new BinaryReader(symChunk, true, "macho");
      symChunkFirst = index;
      symChunkCount = batch;
    }
    const entry = (index - symChunkFirst) * width;
    const nameOffset = symReader.u32(entry);
    if (nameOffset === 0) continue;
    // N_STAB records use a different type namespace. Only an ordinary N_EXT
    // with N_TYPE clear is an undefined external; defined exports are not imports.
    const nType = symReader.u8(entry + 4);
    if ((nType & 0xe0) !== 0 || (nType & 0x0e) !== 0 || (nType & 0x01) === 0)
      continue;
    // A common definition shares those type bits but carries its size in
    // n_value, so only a zero n_value names an import.
    if (
      symReader.u32(entry + 8) !== 0 ||
      (wide && symReader.u32(entry + 12) !== 0)
    )
      continue;
    // After a match, later records are still admitted so symbol order cannot
    // hide a damaged table; their names need not be read.
    if (found !== null) {
      if (nameOffset >= stringSize)
        malformed("Mach-O symbol name offset is outside the string table");
      continue;
    }
    if (nameOffset >= stringSize)
      malformed("Mach-O symbol name offset is outside the string table");
    const absPos = stringAt + nameOffset;
    const remaining = stringEnd - absPos;
    const maximum = MAX_BINARY_HARDENING_SYMBOL_NAME_BYTES;
    const observe = () =>
      observeElfStringTableWindow(
        strWinBuf.subarray(
          absPos - strWinStart,
          absPos - strWinStart + maximum,
        ),
        remaining,
      );
    const cached =
      absPos >= strWinStart && absPos < strWinStart + strWinBuf.length
        ? observe()
        : null;
    let observed = cached;
    if (
      cached === null ||
      (cached.state === "truncated" &&
        cached.scanLimited &&
        cached.examinedBytes < maximum)
    ) {
      const readLen = Math.min(
        Math.max(STREAM_WINDOW_BYTES, maximum),
        remaining,
      );
      strWinBuf = asBuffer(await readAt(absPos, readLen));
      strWinStart = absPos;
      observed = observe();
    }
    if (observed === null || observed.state === "outside")
      malformed("Mach-O symbol name offset is outside the string table");
    scanned += observed.examinedBytes;
    if (scanned > MAX_BINARY_HARDENING_SYMBOL_SCAN_BYTES)
      return unknownStackBudget();
    // A name past the window is unresolved. Later symbols can still carry the sign.
    if (observed.state === "truncated") {
      unterminated = true;
      continue;
    }
    if (
      (observed.contentBytes !== 16 && observed.contentBytes !== 17) ||
      observed.bytes[0] !== 0x5f ||
      observed.bytes[1] !== 0x5f
    )
      continue;
    const name = elfStringTableText(observed) ?? "";
    if (name === "__stack_chk_fail" || name === "___stack_chk_fail")
      found = row(
        "stack_protector",
        "enabled",
        `Undefined symbol ${name} is present.`,
        {
          offset: stringAt + nameOffset,
          bytes: Buffer.byteLength(name),
        },
      );
  }
  if (found !== null) return found;
  if (unterminated)
    return unknownStackBudget(
      `An undefined symbol name has no NUL within the string table or the ${String(MAX_BINARY_HARDENING_SYMBOL_NAME_BYTES)}-byte name budget, so this import sign is unknown.`,
    );
  return row(
    "stack_protector",
    "unknown",
    "No __stack_chk_fail or ___stack_chk_fail symbol was found.",
    null,
    "No __stack_chk_fail or ___stack_chk_fail symbol was found. A stripped image can omit that symbol while still using a stack protector.",
  );
};
