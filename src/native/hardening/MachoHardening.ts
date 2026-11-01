import { validateFatSliceIdentity } from "../../domain/apple/machoContainer.js";
import { machoArchitectureName } from "../../domain/apple/machoCpuIdentity.js";
import {
  MACHO_HEADER_FLAGS_OFFSET,
  readMachoLinkeditDataCommand,
} from "../../domain/apple/machoLoadCommands.js";
import type { MachoSliceEncryption } from "../../domain/apple/machoEncryption.js";
import {
  admitMachoSegmentCommand,
  readMachoSegmentHeader,
} from "../../domain/apple/machoSegmentHeader.js";
import { machoBinaryArchitecture } from "../../domain/binaryTarget.js";
import { decodeMachoFixedName } from "../AppleMachoNames.js";
import {
  elfStringTableText,
  observeElfStringTableEntry,
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
import { assertArtifactReadActive } from "../../artifacts/ArtifactFileOperation.js";
import { BinaryFormatFailure } from "../metadata/BinaryContainer.js";
import { readMachoEncryption } from "../../artifacts/apple/MachoEncryptionReader.js";
import {
  frameLoadCommands,
  readMachoContainer,
  readSliceCommandTable,
  type MachoLoadCommand,
  type MachoSliceHeader,
  type ReadAt,
} from "../../artifacts/apple/MachoLoadCommandReader.js";

const MH_EXECUTE = 0x2;
const MH_DYLIB = 0x6;
const MH_BUNDLE = 0x8;
const MH_ALLOW_STACK_EXECUTION = 0x20000;
const MH_PIE = 0x200000;
const MH_NO_HEAP_EXECUTION = 0x1000000;
const CPU_TYPE_ARM64 = 0x0100000c;
const LC_SEGMENT = 0x1;
const LC_SYMTAB = 0x2;
const LC_SEGMENT_64 = 0x19;
const LC_CODE_SIGNATURE = 0x1d;
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
  const container = await readMachoContainer(readAt, bytes.length);
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
  const refs = sliceRefs(container, bytes.length);
  const encryption = await readMachoEncryption(
    readAt,
    bytes.length,
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
    images.push(await readSliceImage(bytes, ref, encrypted));
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
  bytes: Buffer,
  ref: SliceRef,
  encrypted: MachoSliceEncryption,
): Promise<BinaryHardeningImage> => {
  if (ref.rangeIssue !== null)
    return failedImage(ref, ref.rangeIssue.status, ref.rangeIssue.reason);
  const readAt: ReadAt = async (offset, length) =>
    bytes.subarray(offset, Math.min(bytes.length, offset + length));
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
    const rows = buildRows(bytes, ref, header, facts, encrypted);
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
    if (cause instanceof BinaryFormatFailure && cause.kind === "malformed") {
      if (ref.thin) throw cause;
      return failedImage(ref, "malformed", cause.message, header);
    }
    throw cause;
  }
};

/** Facts the rows need. A load command table can hold millions of small frames. */
type CommandFacts = {
  /** Table-relative offset of the first `__RESTRICT` segment command. */
  restrict: number | null;
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
  const facts: CommandFacts = { restrict: null, signature: null, symtab: null };
  const framed = frameLoadCommands(table, (command) => {
    if (segmentName(command, wide, sliceSize) === "__RESTRICT")
      facts.restrict ??= command.offset;
    if (command.command === LC_CODE_SIGNATURE) {
      admitCodeSignature(command, sliceSize);
      facts.signature ??= command.offset;
    } else if (command.command === LC_SYMTAB) {
      if (facts.symtab !== null)
        malformed("Mach-O slice has more than one LC_SYMTAB");
      facts.symtab = command;
    }
  });
  if (framed.status !== "framed") malformed(framed.reason);
  return facts;
};

const admitCodeSignature = (
  { body, index }: MachoLoadCommand,
  sliceSize: number,
): void => {
  const data = readMachoLinkeditDataCommand(body, true);
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

const buildRows = (
  bytes: Buffer,
  ref: SliceRef,
  header: MachoSliceHeader,
  { restrict, signature, symtab }: CommandFacts,
  encrypted: MachoSliceEncryption,
): BinaryHardeningRow[] => {
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
  const architecture = machoArchitectureName(header.cpuType, header.cpuSubtype);
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
    restrict === null
      ? row("restrict_segment", "disabled", "No segment is named __RESTRICT.")
      : row("restrict_segment", "enabled", "A segment is named __RESTRICT.", {
          offset: ref.offset + header.headerSize + restrict + 8,
          bytes: 16,
        }),
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
    arm64Row(header.cpuType, architecture, ref.offset),
    stackRow(bytes, ref, header.wide, symtab),
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

const segmentName = (
  command: MachoLoadCommand,
  wide: boolean,
  sliceSize: number,
): string | null => {
  const expected = wide ? LC_SEGMENT_64 : LC_SEGMENT;
  if (command.command !== expected) {
    if (command.command === LC_SEGMENT || command.command === LC_SEGMENT_64)
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
  // The fixed 16-byte name ends at the first NUL. Trailing-only stripping
  // would keep junk after an embedded NUL and miss __RESTRICT.
  return decodeMachoFixedName(header.value.nameBytes);
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
  architecture: string,
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
  const enabled = architecture === "arm64e" || architecture === "arm64e.x1";
  return row(
    "arm64e",
    enabled ? "enabled" : "disabled",
    `CPU subtype names this slice ${architecture}.`,
    location,
  );
};

const stackRow = (
  bytes: Buffer,
  ref: SliceRef,
  wide: boolean,
  symtab: MachoLoadCommand | null,
): BinaryHardeningRow => {
  if (symtab === null)
    return row(
      "stack_protector",
      "unknown",
      "LC_SYMTAB is absent, so stack protector use is unknown.",
      null,
      "LC_SYMTAB is absent, so stack protector use is unknown.",
    );
  if (symtab.body.byteLength < 24)
    malformed("Mach-O LC_SYMTAB command is truncated");
  const view = new DataView(
    symtab.body.buffer,
    symtab.body.byteOffset,
    symtab.body.byteLength,
  );
  const symoff = view.getUint32(8, true);
  const nsyms = view.getUint32(12, true);
  const stroff = view.getUint32(16, true);
  const strsize = view.getUint32(20, true);
  // One oversized symbol table must not drop the header rows or sibling slices.
  if (nsyms > MAX_BINARY_HARDENING_TABLE_ENTRIES) return unknownStackBudget();
  const width = wide ? 16 : 12;
  if (
    symoff > ref.size ||
    stroff > ref.size ||
    nsyms * width > ref.size - symoff ||
    strsize > ref.size - stroff
  )
    malformed("Mach-O symbol or string table extends outside the slice");
  const symbolAt = ref.offset + symoff;
  const stringAt = ref.offset + stroff;
  if (
    nsyms * width > bytes.length - symbolAt ||
    strsize > bytes.length - stringAt
  )
    malformed("Mach-O symbol or string table extends outside the file");
  const strings = bytes.subarray(stringAt, stringAt + strsize);
  let scanned = 0;
  let unterminated = false;
  for (let index = 0; index < nsyms; index += 1) {
    const entry = symbolAt + index * width;
    const nameOffset = bytes.readUInt32LE(entry);
    if (nameOffset === 0) continue;
    // N_EXT with N_TYPE clear is an undefined external. A defined export of
    // the same name, including libc itself, is not an import into this image.
    const nType = bytes.readUInt8(entry + 4);
    if ((nType & 0x0e) !== 0 || (nType & 0x01) === 0) continue;
    const observed = observeElfStringTableEntry(
      strings,
      nameOffset,
      MAX_BINARY_HARDENING_SYMBOL_NAME_BYTES,
    );
    scanned += observed.examinedBytes;
    if (scanned > MAX_BINARY_HARDENING_SYMBOL_SCAN_BYTES)
      return unknownStackBudget();
    if (observed.state === "outside")
      malformed("Mach-O symbol name offset is outside the string table");
    // A name past the window is unresolved. Later symbols can still carry the sign.
    if (observed.state === "truncated") {
      unterminated = true;
      continue;
    }
    const name = elfStringTableText(observed) ?? "";
    if (name === "__stack_chk_fail" || name === "___stack_chk_fail")
      return row(
        "stack_protector",
        "enabled",
        `Undefined symbol ${name} is present.`,
        {
          offset: stringAt + nameOffset,
          bytes: Buffer.byteLength(name),
        },
      );
  }
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
