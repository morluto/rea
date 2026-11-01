import { binaryMetadataArchitecture } from "../../domain/binaryMetadataArchitecture.js";
import type { BinaryArchitecture } from "../../domain/binaryTargetTypes.js";
import { elfArchitecture } from "../../domain/elfFixedHeader.js";
import {
  DWARF_SECTION_ROLES,
  MAX_DWARF_DECOMPRESSED_SECTION_BYTES,
  type DwarfSectionRole,
} from "../../domain/native/dwarfUnits.js";
import { peSubjectArchitecture } from "../../domain/peMachine.js";
import {
  BinaryFormatFailure,
  BinaryResourceFailure,
  type ImageSection,
} from "../metadata/BinaryContainer.js";
import {
  decodeElfCompressedSection,
  decodeElfGnuZlibSection,
  type ElfCompressedSectionResult,
} from "../metadata/ElfCompressedSection.js";
import { readMachoImage } from "../metadata/MachoImage.js";
import {
  readElfDirectoryFromBuffer,
  readPeSectionDirectory,
  type NativeSection,
  type NativeSectionDirectory,
} from "../metadata/NativeSectionDirectory.js";

const SHF_COMPRESSED = 0x800n;
const ET_REL = 1;
/** SHT_RELA, SHT_REL, SHT_CREL, and the earlier LLVM CREL encoding. */
const ELF_RELOCATION_TYPES = new Set([4, 9, 20, 0x40000014]);
const ROLES = new Set<string>(DWARF_SECTION_ROLES);
const SHT_NOBITS = 8;
const MACHO_DWARF_SEGMENT = "__DWARF,";
const MACHO_ZERO_FILL_TYPES = new Set([0x1, 0xc, 0x12]);
const SPLIT_DEBUG_INFO = ".debug_info.dwo";
const MAX_PE_SECTION_NAME_BYTES = 65536;
const MAX_PE_DECODED_NAME_BYTES = 16 * 1024 * 1024;
const DUPLICATE_SECTION =
  "Duplicate section; the first file-backed copy was read";

/** A debug section's decompressed size exceeds the fixed allowance. */
export class DwarfSectionAllowanceFailure extends Error {
  override readonly name = "DwarfSectionAllowanceFailure";

  constructor(
    readonly section: string,
    readonly requiredBytes: bigint,
    readonly maximumBytes: number,
  ) {
    super(
      `${section} decompresses to ${requiredBytes.toString()} bytes, above the ${String(maximumBytes)}-byte DWARF section allowance`,
    );
  }
}

export interface LocatedDwarfSection {
  readonly name: string;
  readonly role: DwarfSectionRole;
  readonly offset: number;
  readonly size: number;
  readonly compression: "none" | "zlib" | "zstd";
  readonly uncompressed_size: number;
  readonly bytes: Buffer;
}

export interface DwarfSectionOmission {
  readonly name: string;
  readonly reason: string;
}

/** What this file establishes about `.debug_info`. */
export type DebugInfoAvailability =
  /** Read. `unreadCopies` counts further `.debug_info` sections left unread. */
  | { readonly state: "read"; readonly unreadCopies: number }
  /** No section in this file claims the role. */
  | { readonly state: "absent" }
  /** The section is declared and stores no bytes (`SHT_NOBITS`, zero fill). */
  | { readonly state: "no_contents" }
  /** The section stores bytes that were not decoded. Its units are unknown. */
  | { readonly state: "unreadable"; readonly reason: string };

/** Slice-relative debug sections. The caller adds a universal-slice file offset. */
export interface LocatedDwarfImage {
  readonly format: "elf" | "pe" | "macho";
  readonly bits: 32 | 64;
  readonly byte_order: "little" | "big";
  readonly machine: number | null;
  readonly architecture: BinaryArchitecture | null;
  readonly sections: readonly LocatedDwarfSection[];
  readonly omissions: readonly DwarfSectionOmission[];
  readonly gnuDebugLink: boolean;
  readonly debugInfo: DebugInfoAvailability;
  readonly info: Buffer | null;
  readonly abbrev: Buffer | null;
  readonly str: Buffer | null;
  readonly lineStr: Buffer | null;
  readonly strOffsets: Buffer | null;
  /** Null when `.debug_info` is absent or compressed. */
  readonly infoFileOffset: number | null;
  readonly infoCompressed: boolean;
  /** Names of sections relocating DWARF on an ET_REL image; not applied. */
  readonly unappliedDebugRelocations: readonly string[];
}

interface UnreadSection {
  readonly kind: "no_contents" | "unreadable" | "duplicate";
  readonly reason: string;
}

interface Candidate {
  readonly name: string;
  readonly role: DwarfSectionRole;
  readonly offset: number;
  readonly size: number;
  readonly unread: UnreadSection | null;
  readonly body: Buffer;
  readonly compression: "none" | "zlib" | "zstd";
  readonly uncompressedSize: number;
}

/** Select DWARF sections from one thin ELF, PE, or Mach-O image. */
export const locateDwarfSections = (
  bytes: Buffer,
  maximumDecodedBytes = MAX_DWARF_DECOMPRESSED_SECTION_BYTES,
): LocatedDwarfImage => {
  const budget: InflateBudget = { allowance: maximumDecodedBytes, used: 0 };
  if (bytes.length >= 4 && bytes.readUInt32LE(0) === 0x464c457f)
    return finish(locateElf(bytes, budget));
  if (bytes.length >= 2 && bytes[0] === 0x4d && bytes[1] === 0x5a)
    return finish(locatePe(bytes, budget));
  if (bytes.length >= 4 && isMachoMagic(bytes.readUInt32BE(0)))
    return finish(locateMacho(bytes, budget));
  throw new BinaryFormatFailure(
    "unsupported",
    "File is not an ELF, PE, or Mach-O image",
  );
};

const isMachoMagic = (magic: number): boolean =>
  magic === 0xfeedface ||
  magic === 0xfeedfacf ||
  magic === 0xcefaedfe ||
  magic === 0xcffaedfe;

const roleOf = (normalized: string): DwarfSectionRole | null =>
  ROLES.has(normalized) ? (normalized as DwarfSectionRole) : null;

/** ELF and PE spell DWARF sections `.debug_*` or legacy `.zdebug_*`. */
const objectSectionRole = (stored: string): DwarfSectionRole | null =>
  roleOf(normalizeObjectSectionName(stored));

const normalizeObjectSectionName = (stored: string): string =>
  stored.startsWith(".zdebug_")
    ? `.debug_${stored.slice(".zdebug_".length)}`
    : stored;

/** Mach-O caps section names at 16 bytes, so two compressed names are cut short. */
const machoSectionRole = (stored: string): DwarfSectionRole | null => {
  if (stored === "__debug_str_offs" || stored === "__zdebug_str_off")
    return ".debug_str_offsets";
  if (stored === "__zdebug_line_st") return ".debug_line_str";
  if (stored.startsWith("__zdebug_"))
    return roleOf(`.debug_${stored.slice("__zdebug_".length)}`);
  return stored.startsWith("__debug_") ? roleOf(`.${stored.slice(2)}`) : null;
};

const gnuZdebugName = (name: string): boolean =>
  name.startsWith(".zdebug_") || name.startsWith("__zdebug_");

const decodeBudget = (budget: InflateBudget, name: string): number => {
  if (budget.used >= budget.allowance)
    throw new DwarfSectionAllowanceFailure(
      name,
      BigInt(budget.used) + 1n,
      budget.allowance,
    );
  return budget.allowance - budget.used;
};

const unread = (
  name: string,
  role: DwarfSectionRole,
  kind: UnreadSection["kind"],
  reason: string,
): Candidate => ({
  name,
  role,
  offset: 0,
  size: 0,
  unread: { kind, reason },
  body: Buffer.alloc(0),
  compression: "none",
  uncompressedSize: 0,
});

const storedCandidate = (
  name: string,
  role: DwarfSectionRole,
  offset: number,
  size: number,
  body: Buffer,
): Candidate => ({
  name,
  role,
  offset,
  size,
  unread: null,
  body,
  compression: "none",
  uncompressedSize: size,
});

/**
 * A section that stores no bytes satisfies nothing: a `.debug_info` with an
 * empty body is no contents, so a later populated copy is still selectable.
 */
const settle = (
  candidate: Candidate,
  satisfied: Set<DwarfSectionRole>,
): Candidate => {
  if (candidate.unread !== null) return candidate;
  if (candidate.role === ".debug_info" && candidate.body.length === 0)
    return unread(
      candidate.name,
      candidate.role,
      "no_contents",
      `${candidate.name} stores no bytes`,
    );
  satisfied.add(candidate.role);
  return candidate;
};

const admitDecoded = (
  name: string,
  role: DwarfSectionRole,
  offset: number,
  size: number,
  decoded: ElfCompressedSectionResult,
  budget: InflateBudget,
  unsupported: string,
): Candidate => {
  if (decoded.state === "limit") {
    const demanded =
      decoded.requiredBytes > BigInt(budget.allowance)
        ? decoded.requiredBytes
        : decoded.requiredBytes + BigInt(budget.used);
    throw new DwarfSectionAllowanceFailure(name, demanded, budget.allowance);
  }
  if (decoded.state === "malformed") {
    // The owner charges the larger of declared output and compressed input
    // read on failure. Rejected headers never inflate and charge 0.
    budget.used += decoded.inflatedBytes;
    return unread(name, role, "unreadable", decoded.message);
  }
  if (decoded.state === "unsupported")
    return unread(name, role, "unreadable", unsupported);
  budget.used += decoded.bytes.length;
  return {
    name,
    role,
    offset,
    size,
    unread: null,
    body: decoded.bytes,
    compression: decoded.compression,
    uncompressedSize: decoded.bytes.length,
  };
};

const outsideFile = (name: string, role: DwarfSectionRole): Candidate =>
  unread(name, role, "unreadable", `${name} range is outside the file`);

const fits = (offset: bigint, size: bigint, fileBytes: number): boolean =>
  offset >= 0n &&
  size >= 0n &&
  offset <= BigInt(fileBytes) &&
  size <= BigInt(fileBytes) - offset;

const asNumber = (value: bigint): number => {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER))
    throw new BinaryFormatFailure(
      "malformed",
      "Section offset exceeds exact host precision",
    );
  return Number(value);
};

interface ImageIdentity {
  readonly format: "elf" | "pe" | "macho";
  readonly bits: 32 | 64;
  readonly byte_order: "little" | "big";
  readonly machine: number | null;
  readonly architecture: BinaryArchitecture | null;
  readonly candidates: readonly Candidate[];
  readonly gnuDebugLink: boolean;
  readonly unappliedDebugRelocations: readonly string[];
}

interface InflateBudget {
  readonly allowance: number;
  used: number;
}

/** One row per name and reason, so repeated sections cannot grow the report. */
const groupOmissions = (
  omitted: readonly DwarfSectionOmission[],
): DwarfSectionOmission[] => {
  const groups = new Map<
    string,
    { readonly omission: DwarfSectionOmission; count: number }
  >();
  for (const omission of omitted) {
    const key = JSON.stringify([omission.name, omission.reason]);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, { omission, count: 1 });
    else group.count += 1;
  }
  return [...groups.values()].map(({ omission, count }) =>
    count === 1
      ? omission
      : {
          ...omission,
          reason: `${omission.reason} (${String(count)} sections)`,
        },
  );
};

const debugInfoAvailability = (
  candidates: readonly Candidate[],
): DebugInfoAvailability => {
  const matches = candidates.filter(({ role }) => role === ".debug_info");
  if (matches.length === 0) return { state: "absent" };
  if (matches.some((candidate) => candidate.unread === null))
    return {
      state: "read",
      unreadCopies: matches.filter(
        ({ unread }) => unread !== null && unread.kind !== "no_contents",
      ).length,
    };
  const reason = matches.find(({ unread }) => unread?.kind === "unreadable")
    ?.unread?.reason;
  return reason === undefined
    ? { state: "no_contents" }
    : { state: "unreadable", reason };
};

const finish = (image: ImageIdentity): LocatedDwarfImage => {
  const sections: LocatedDwarfSection[] = [];
  const omitted: DwarfSectionOmission[] = [];
  const chosen = new Map<DwarfSectionRole, LocatedDwarfSection>();
  for (const role of DWARF_SECTION_ROLES) {
    const matches = image.candidates.filter(
      (candidate) => candidate.role === role,
    );
    if (matches.length === 0)
      omitted.push({
        name: role,
        reason: `${role} was not observed in this file`,
      });
    const first = matches.find((candidate) => candidate.unread === null);
    for (const candidate of matches)
      if (candidate !== first)
        omitted.push({
          name: candidate.name,
          reason: candidate.unread?.reason ?? DUPLICATE_SECTION,
        });
    if (first === undefined) continue;
    const section: LocatedDwarfSection = {
      name: first.name,
      role,
      offset: first.offset,
      size: first.size,
      compression: first.compression,
      uncompressed_size: first.uncompressedSize,
      bytes: first.body,
    };
    chosen.set(role, section);
    sections.push(section);
  }
  const info = chosen.get(".debug_info");
  return {
    format: image.format,
    bits: image.bits,
    byte_order: image.byte_order,
    machine: image.machine,
    architecture: image.architecture,
    sections,
    omissions: groupOmissions(omitted),
    gnuDebugLink: image.gnuDebugLink,
    debugInfo: debugInfoAvailability(image.candidates),
    info: info?.bytes ?? null,
    abbrev: chosen.get(".debug_abbrev")?.bytes ?? null,
    str: chosen.get(".debug_str")?.bytes ?? null,
    lineStr: chosen.get(".debug_line_str")?.bytes ?? null,
    strOffsets: chosen.get(".debug_str_offsets")?.bytes ?? null,
    infoFileOffset:
      info === undefined || info.compression !== "none" ? null : info.offset,
    infoCompressed: info !== undefined && info.compression !== "none",
    unappliedDebugRelocations: image.unappliedDebugRelocations,
  };
};

const locateElf = (bytes: Buffer, budget: InflateBudget): ImageIdentity => {
  const directory = readElfDirectoryFromBuffer(bytes);
  if (directory.section_names_limitation !== undefined)
    throw new BinaryFormatFailure(
      "unsupported",
      directory.section_names_limitation,
    );
  let gnuDebugLink = false;
  const candidates: Candidate[] = [];
  const relocations = new Set<string>();
  const satisfied = new Set<DwarfSectionRole>();
  for (const section of directory.sections) {
    if (section.name_state !== "known" || section.name === null)
      throw new BinaryFormatFailure(
        "unsupported",
        "ELF section names are incomplete",
      );
    if (section.name === ".gnu_debuglink") gnuDebugLink = true;
    const relocationTarget = directory.sections[section.info];
    if (
      directory.elf_type === ET_REL &&
      ELF_RELOCATION_TYPES.has(section.type) &&
      relocationTarget?.name_state === "known" &&
      relocationTarget.name !== null &&
      normalizeObjectSectionName(relocationTarget.name).startsWith(".debug_")
    )
      relocations.add(section.name);
    if (normalizeObjectSectionName(section.name) === SPLIT_DEBUG_INFO) {
      candidates.push(
        unread(
          section.name,
          ".debug_info",
          "unreadable",
          `Split DWARF section ${section.name} is not read`,
        ),
      );
      continue;
    }
    const role = objectSectionRole(section.name);
    if (role === null) continue;
    const name = section.name;
    if (section.type === SHT_NOBITS) {
      candidates.push(
        unread(name, role, "no_contents", `${name} is not file-backed`),
      );
      continue;
    }
    if (!fits(section.offset, section.size, bytes.length)) {
      candidates.push(outsideFile(name, role));
      continue;
    }
    if (satisfied.has(role)) {
      candidates.push(unread(name, role, "duplicate", DUPLICATE_SECTION));
      continue;
    }
    const offset = asNumber(section.offset);
    const size = asNumber(section.size);
    const stored = bytes.subarray(offset, offset + size);
    const gnuZlib = name.startsWith(".zdebug_");
    const compressed = (section.flags & SHF_COMPRESSED) !== 0n;
    if (!compressed && !gnuZlib) {
      candidates.push(
        settle(storedCandidate(name, role, offset, size, stored), satisfied),
      );
      continue;
    }
    const decoded = compressed
      ? decodeElfCompressedSection(
          stored,
          section.flags,
          directory.bits,
          directory.little,
          decodeBudget(budget, name),
          `ELF ${name} section`,
        )
      : decodeElfGnuZlibSection(
          stored,
          decodeBudget(budget, name),
          `ELF ${name} section`,
        );
    const candidate = admitDecoded(
      name,
      role,
      offset,
      size,
      decoded,
      budget,
      `ELF ${name} compression type ${
        decoded.state === "unsupported"
          ? String(decoded.compressionType)
          : "unknown"
      } is unsupported`,
    );
    candidates.push(settle(candidate, satisfied));
  }
  return {
    format: "elf",
    bits: directory.bits,
    byte_order: directory.little ? "little" : "big",
    machine: directory.machine,
    architecture: elfArchitecture(directory.machine) ?? null,
    candidates,
    gnuDebugLink,
    unappliedDebugRelocations: [...relocations],
  };
};

const adoptStored = (
  name: string,
  role: DwarfSectionRole,
  offset: number,
  size: number,
  stored: Buffer,
  budget: InflateBudget,
  satisfied: Set<DwarfSectionRole>,
  subject: string,
): Candidate => {
  if (satisfied.has(role))
    return unread(name, role, "duplicate", DUPLICATE_SECTION);
  if (!gnuZdebugName(name)) {
    return settle(storedCandidate(name, role, offset, size, stored), satisfied);
  }
  const candidate = admitDecoded(
    name,
    role,
    offset,
    size,
    decodeElfGnuZlibSection(stored, decodeBudget(budget, name), subject),
    budget,
    `${subject} compression is unsupported`,
  );
  return settle(candidate, satisfied);
};

const locatePe = (bytes: Buffer, budget: InflateBudget): ImageIdentity => {
  const directory = readPeDirectory(bytes);
  const names = peSectionNames(bytes, directory);
  const candidates: Candidate[] = [];
  const satisfied = new Set<DwarfSectionRole>();
  for (const section of directory.sections) {
    const name = names.get(section.index);
    if (name === undefined) continue;
    const role = objectSectionRole(name);
    if (role === null) continue;
    if (!fits(section.offset, section.size, bytes.length)) {
      candidates.push(outsideFile(name, role));
      continue;
    }
    const offset = asNumber(section.offset);
    const size = asNumber(section.size);
    candidates.push(
      adoptStored(
        name,
        role,
        offset,
        size,
        bytes.subarray(offset, offset + size),
        budget,
        satisfied,
        `PE ${name} section`,
      ),
    );
  }
  return {
    format: "pe",
    bits: directory.bits,
    byte_order: "little",
    machine: directory.machine,
    architecture:
      peSubjectArchitecture(
        directory.machine,
        directory.bits === 64 ? "pe32-plus" : "pe32",
      ) ?? null,
    candidates,
    gnuDebugLink: [...names.values()].includes(".gnu_debuglink"),
    unappliedDebugRelocations: [],
  };
};

const readPeDirectory = (bytes: Buffer) => {
  const steps = readPeSectionDirectory(bytes.length);
  let next = steps.next();
  while (!next.done) {
    const { offset, size } = next.value;
    next = steps.next(bytes.subarray(offset, offset + size));
  }
  return next.value;
};

/** Resolve COFF `/decimal` and GNU `//base64` names. Unresolved names hide `.debug_info`. */
const peSectionNames = (
  bytes: Buffer,
  directory: NativeSectionDirectory,
): ReadonlyMap<number, string> => {
  const { sections } = directory;
  const names = new Map<number, string>();
  const decodedNames = new Map<number, string>();
  let decodedNameBytes = 0;
  const long = sections.filter(
    (section) => section.name !== null && section.name.startsWith("/"),
  );
  let strings: Buffer | null = null;
  if (long.length > 0) {
    if (directory.pe_symbol_table === undefined)
      throw new BinaryFormatFailure(
        "malformed",
        "PE string table is unavailable",
      );
    const { offset: symbolOffset, count: symbolCount } =
      directory.pe_symbol_table;
    const table =
      symbolOffset > bytes.length ? null : symbolOffset + symbolCount * 18;
    if (
      table === null ||
      symbolCount > bytes.length ||
      table > bytes.length - 4
    )
      throw new BinaryFormatFailure(
        "malformed",
        "PE long section name string table is unavailable",
      );
    const tableSize = bytes.readUInt32LE(table);
    if (tableSize < 4 || tableSize > bytes.length - table)
      throw new BinaryFormatFailure(
        "malformed",
        "PE long section name string table is truncated",
      );
    strings = bytes.subarray(table, table + tableSize);
  }
  for (const section of sections) {
    const raw = section.name ?? "";
    if (!raw.startsWith("/")) {
      if (raw.length > 0) names.set(section.index, raw);
      continue;
    }
    let at = NaN;
    if (/^\/[0-9]+$/u.test(raw)) at = Number(raw.slice(1));
    else if (/^\/\/[A-Za-z0-9+/]{6}$/u.test(raw)) {
      const alphabet =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
      at = 0;
      for (const digit of raw.slice(2)) at = at * 64 + alphabet.indexOf(digit);
    }
    if (
      strings === null ||
      !Number.isSafeInteger(at) ||
      at < 4 ||
      at >= strings.length
    )
      throw new BinaryFormatFailure(
        "malformed",
        `PE section name ${raw} could not be resolved`,
      );
    const cached = decodedNames.get(at);
    if (cached !== undefined) {
      names.set(section.index, cached);
      continue;
    }
    // Reserve two bytes per character before allocating a JavaScript string.
    const remainingCharacters = Math.floor(
      (MAX_PE_DECODED_NAME_BYTES - decodedNameBytes) / 2,
    );
    const maximumCharacters = Math.min(
      MAX_PE_SECTION_NAME_BYTES,
      remainingCharacters,
    );
    const end = Math.min(strings.length, at + maximumCharacters + 1);
    const relativeNul = strings.subarray(at, end).indexOf(0);
    if (relativeNul < 0 && end - at > maximumCharacters)
      throw new BinaryResourceFailure(
        "structure",
        remainingCharacters < MAX_PE_SECTION_NAME_BYTES
          ? MAX_PE_DECODED_NAME_BYTES
          : MAX_PE_SECTION_NAME_BYTES,
        remainingCharacters < MAX_PE_SECTION_NAME_BYTES
          ? "Decoded PE section names exceed the 16 MiB structural budget"
          : "PE section name exceeds the 65536-byte decoding allowance",
      );
    const nul = relativeNul < 0 ? -1 : at + relativeNul;
    if (nul < 0)
      throw new BinaryFormatFailure(
        "malformed",
        `PE section name ${raw} could not be resolved`,
      );
    decodedNameBytes += (nul - at) * 2;
    const name = strings.toString("latin1", at, nul);
    decodedNames.set(at, name);
    names.set(section.index, name);
  }
  return names;
};

const locateMacho = (bytes: Buffer, budget: InflateBudget): ImageIdentity => {
  const image = readMachoImage(bytes);
  const candidates: Candidate[] = [];
  const satisfied = new Set<DwarfSectionRole>();
  for (const section of image.sections) {
    if (section.format !== "macho") continue;
    if (!section.name.startsWith(MACHO_DWARF_SEGMENT)) continue;
    const role = machoSectionRole(section.section_name);
    if (role === null) continue;
    const name = section.section_name;
    if (MACHO_ZERO_FILL_TYPES.has(section.type)) {
      candidates.push(
        unread(name, role, "no_contents", `${name} is not file-backed`),
      );
      continue;
    }
    if (!machoReadable(section, bytes.length)) {
      candidates.push(outsideFile(name, role));
      continue;
    }
    const offset = Number(section.declared_range.offset);
    const size = Number(section.declared_range.size);
    candidates.push(
      adoptStored(
        name,
        role,
        offset,
        size,
        bytes.subarray(offset, offset + size),
        budget,
        satisfied,
        `Mach-O ${name} section`,
      ),
    );
  }
  return {
    format: "macho",
    bits: image.bits,
    byte_order: image.byte_order,
    machine: image.macho_cpu_type,
    architecture: binaryMetadataArchitecture(image.architecture) ?? null,
    candidates,
    gnuDebugLink: false,
    unappliedDebugRelocations: [],
  };
};

const machoReadable = (
  section: Extract<ImageSection, { format: "macho" }>,
  fileBytes: number,
): boolean =>
  section.on_disk ||
  (section.size === 0 &&
    !section.segment_unmapped &&
    section.declared_range.size === 0n &&
    section.declared_range.offset >= 0n &&
    section.declared_range.offset <= BigInt(fileBytes));
