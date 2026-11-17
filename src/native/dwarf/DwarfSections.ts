import { binaryMetadataArchitecture } from "../../domain/binaryMetadataArchitecture.js";
import type { BinaryArchitecture } from "../../domain/binaryTargetTypes.js";
import { elfArchitecture } from "../../domain/elfFixedHeader.js";
import {
  DWARF_LINE_SECTION_ROLES,
  type DwarfLineSectionRole,
} from "../../domain/native/dwarfLines.js";
import {
  DWARF_SECTION_ROLES,
  MAX_DWARF_DECOMPRESSED_SECTION_BYTES,
  type DwarfSectionRole,
} from "../../domain/native/dwarfUnits.js";
import { ParseFailureError } from "../../domain/parseFailure.js";
import { peSubjectArchitecture } from "../../domain/peMachine.js";
import {
  BinaryFormatFailure,
  BinaryReader,
  BinaryResourceFailure,
  type ImageSection,
} from "../../domain/binaryContainer.js";
import {
  decodeElfCompressedSection,
  decodeElfGnuZlibSection,
  type ElfCompressedSectionResult,
} from "../../domain/native/elfCompressedSection.js";
import { readMachoImage } from "../../domain/apple/machoImage.js";
import {
  readElfDirectoryFromBuffer,
  readPeSectionDirectory,
  type NativeSection,
  type NativeSectionDirectory,
} from "../../domain/native/nativeSectionDirectory.js";

const SHF_COMPRESSED = 0x800n;
const ET_REL = 1;
/** SHT_RELA, SHT_REL, SHT_CREL, and the earlier LLVM CREL encoding. */
const ELF_RELOCATION_TYPES = new Set([4, 9, 20, 0x40000014]);
type AnyDwarfRole = DwarfSectionRole | DwarfLineSectionRole;
const UNIT_ROLES = new Set<string>(DWARF_SECTION_ROLES);
const LINE_ROLES = new Set<string>(DWARF_LINE_SECTION_ROLES);
const SHT_NOBITS = 8;
const MACHO_DWARF_SEGMENT = "__DWARF,";
const MACHO_ZERO_FILL_TYPES = new Set([0x1, 0xc, 0x12]);
const SPLIT_DEBUG_INFO = ".debug_info.dwo";
const MAX_PE_SECTION_NAME_BYTES = 65536;
const MAX_PE_DECODED_NAME_BYTES = 16 * 1024 * 1024;
const DUPLICATE_SECTION =
  "Duplicate section; the first file-backed copy was read";

/** A debug section's decompressed size exceeds the fixed allowance. */
export class DwarfSectionAllowanceFailure extends ParseFailureError<"limit"> {
  constructor(
    readonly section: string,
    readonly requiredBytes: bigint,
    readonly maximumBytes: number,
  ) {
    super({
      kind: "limit",
      format: "dwarf",
      detail: `${section} decompresses to ${requiredBytes.toString()} bytes, above the ${String(maximumBytes)}-byte DWARF section allowance`,
      limit: {
        name: "decompressed_section_bytes",
        maximum: maximumBytes,
        required: requiredBytes,
      },
    });
    this.name = "DwarfSectionAllowanceFailure";
  }
}

export interface LocatedDwarfSectionBase<
  Role extends AnyDwarfRole = DwarfSectionRole,
> {
  readonly name: string;
  readonly role: Role;
  readonly offset: number;
  readonly size: number;
  readonly compression: "none" | "zlib" | "zstd";
  readonly uncompressed_size: number;
  readonly bytes: Buffer;
}

export type LocatedDwarfSection = LocatedDwarfSectionBase<DwarfSectionRole>;
export type LocatedDwarfLineSection =
  LocatedDwarfSectionBase<DwarfLineSectionRole>;

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

/** Slice-relative line-program debug sections. */
export interface LocatedDwarfLineImage {
  readonly format: "elf" | "pe" | "macho";
  readonly bits: 32 | 64;
  readonly byte_order: "little" | "big";
  readonly machine: number | null;
  readonly architecture: BinaryArchitecture | null;
  readonly sections: readonly LocatedDwarfLineSection[];
  readonly omissions: readonly DwarfSectionOmission[];
  readonly gnuDebugLink: boolean;
  readonly debugLine: DebugInfoAvailability;
  readonly line: Buffer | null;
  readonly lineStr: Buffer | null;
  readonly str: Buffer | null;
  readonly strOffsets: Buffer | null;
  /** Null when `.debug_line` is absent or compressed. */
  readonly lineFileOffset: number | null;
  readonly lineCompressed: boolean;
  /** Relocations targeting `.debug_line` or its string/offset tables on ET_REL. */
  readonly unappliedLineRelocations: readonly string[];
  /** Relocations targeting any DWARF `.debug_*` section on ET_REL. */
  readonly unappliedDebugRelocations: readonly string[];
}

interface UnreadSection {
  readonly kind: "no_contents" | "unreadable" | "duplicate";
  readonly reason: string;
}

interface Candidate<Role extends AnyDwarfRole = AnyDwarfRole> {
  readonly name: string;
  readonly role: Role;
  readonly offset: number;
  readonly size: number;
  readonly unread: UnreadSection | null;
  readonly body: Buffer;
  readonly compression: "none" | "zlib" | "zstd";
  readonly uncompressedSize: number;
}

const locateRawImage = <Role extends AnyDwarfRole>(
  bytes: Buffer,
  maximumDecodedBytes: number,
  roles: ReadonlySet<string>,
): ImageIdentity<Role> => {
  const budget: InflateBudget = { allowance: maximumDecodedBytes, used: 0 };
  const magic =
    bytes.length >= 4 ? new BinaryReader(bytes, true, "dwarf").u32(0) : null;
  if (magic === 0x464c457f) return locateElf(bytes, budget, roles);
  if (bytes.length >= 2 && bytes[0] === 0x4d && bytes[1] === 0x5a)
    return locatePe(bytes, budget, roles);
  if (
    bytes.length >= 4 &&
    isMachoMagic(new BinaryReader(bytes, false, "dwarf").u32(0))
  )
    return locateMacho(bytes, budget, roles);
  throw new BinaryFormatFailure(
    "unsupported",
    "File is not an ELF, PE, or Mach-O image",
  );
};

/** Select DWARF sections from one thin ELF, PE, or Mach-O image. */
export const locateDwarfSections = (
  bytes: Buffer,
  maximumDecodedBytes = MAX_DWARF_DECOMPRESSED_SECTION_BYTES,
): LocatedDwarfImage =>
  finishUnits(
    locateRawImage<DwarfSectionRole>(bytes, maximumDecodedBytes, UNIT_ROLES),
  );

/** Select DWARF line-number program sections from one thin ELF, PE, or Mach-O image. */
export const locateDwarfLineSections = (
  bytes: Buffer,
  maximumDecodedBytes = MAX_DWARF_DECOMPRESSED_SECTION_BYTES,
): LocatedDwarfLineImage =>
  finishLines(
    locateRawImage<DwarfLineSectionRole>(
      bytes,
      maximumDecodedBytes,
      LINE_ROLES,
    ),
  );

const isMachoMagic = (magic: number): boolean =>
  magic === 0xfeedface ||
  magic === 0xfeedfacf ||
  magic === 0xcefaedfe ||
  magic === 0xcffaedfe;

const roleOf = <Role extends AnyDwarfRole>(
  normalized: string,
  roles: ReadonlySet<string>,
): Role | null => (roles.has(normalized) ? (normalized as Role) : null);

/** ELF and PE spell DWARF sections `.debug_*` or legacy `.zdebug_*`. */
const objectSectionRole = <Role extends AnyDwarfRole>(
  stored: string,
  roles: ReadonlySet<string>,
): Role | null => roleOf<Role>(normalizeObjectSectionName(stored), roles);

const normalizeObjectSectionName = (stored: string): string =>
  stored.startsWith(".zdebug_")
    ? `.debug_${stored.slice(".zdebug_".length)}`
    : stored;

/** Mach-O caps section names at 16 bytes, so two compressed names are cut short. */
const machoSectionRole = <Role extends AnyDwarfRole>(
  stored: string,
  roles: ReadonlySet<string>,
): Role | null => {
  if (stored === "__debug_str_offs" || stored === "__zdebug_str_off")
    return roleOf<Role>(".debug_str_offsets", roles);
  if (stored === "__zdebug_line_st")
    return roleOf<Role>(".debug_line_str", roles);
  if (stored.startsWith("__zdebug_"))
    return roleOf<Role>(`.debug_${stored.slice("__zdebug_".length)}`, roles);
  return stored.startsWith("__debug_")
    ? roleOf<Role>(`.${stored.slice(2)}`, roles)
    : null;
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

const unread = <Role extends AnyDwarfRole>(
  name: string,
  role: Role,
  kind: UnreadSection["kind"],
  reason: string,
): Candidate<Role> => ({
  name,
  role,
  offset: 0,
  size: 0,
  unread: { kind, reason },
  body: Buffer.alloc(0),
  compression: "none",
  uncompressedSize: 0,
});

const storedCandidate = <Role extends AnyDwarfRole>(
  name: string,
  role: Role,
  offset: number,
  size: number,
  body: Buffer,
): Candidate<Role> => ({
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
 * A primary DWARF stream that stores no bytes satisfies nothing: an empty body
 * is no contents, so a later populated copy is still selectable.
 */
const settle = <Role extends AnyDwarfRole>(
  candidate: Candidate<Role>,
  satisfied: Set<Role>,
): Candidate<Role> => {
  if (candidate.unread !== null) return candidate;
  if (
    (candidate.role === ".debug_info" || candidate.role === ".debug_line") &&
    candidate.body.length === 0
  )
    return unread(
      candidate.name,
      candidate.role,
      "no_contents",
      `${candidate.name} stores no bytes`,
    );
  satisfied.add(candidate.role);
  return candidate;
};

const admitDecoded = <Role extends AnyDwarfRole>(
  name: string,
  role: Role,
  offset: number,
  size: number,
  decoded: ElfCompressedSectionResult,
  budget: InflateBudget,
  unsupported: string,
): Candidate<Role> => {
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
  budget.used += decoded.inflatedBytes;
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

const outsideFile = <Role extends AnyDwarfRole>(
  name: string,
  role: Role,
): Candidate<Role> =>
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

interface ImageIdentity<Role extends AnyDwarfRole = AnyDwarfRole> {
  readonly format: "elf" | "pe" | "macho";
  readonly bits: 32 | 64;
  readonly byte_order: "little" | "big";
  readonly machine: number | null;
  readonly architecture: BinaryArchitecture | null;
  readonly candidates: readonly Candidate<Role>[];
  readonly gnuDebugLink: boolean;
  readonly unappliedLineRelocations: readonly string[];
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

const roleAvailability = <Role extends AnyDwarfRole>(
  candidates: readonly Candidate<Role>[],
  targetRole: Role,
): DebugInfoAvailability => {
  const matches = candidates.filter(({ role }) => role === targetRole);
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

const selectSections = <Role extends AnyDwarfRole>(
  image: ImageIdentity<Role>,
  roles: readonly Role[],
): {
  readonly sections: LocatedDwarfSectionBase<Role>[];
  readonly omissions: DwarfSectionOmission[];
  readonly chosen: Map<Role, LocatedDwarfSectionBase<Role>>;
} => {
  const sections: LocatedDwarfSectionBase<Role>[] = [];
  const omitted: DwarfSectionOmission[] = [];
  const chosen = new Map<Role, LocatedDwarfSectionBase<Role>>();
  for (const role of roles) {
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
    const section: LocatedDwarfSectionBase<Role> = {
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
  return { sections, omissions: groupOmissions(omitted), chosen };
};

const finishUnits = (
  image: ImageIdentity<DwarfSectionRole>,
): LocatedDwarfImage => {
  const { sections, omissions, chosen } = selectSections(
    image,
    DWARF_SECTION_ROLES,
  );
  const info = chosen.get(".debug_info");
  return {
    format: image.format,
    bits: image.bits,
    byte_order: image.byte_order,
    machine: image.machine,
    architecture: image.architecture,
    sections,
    omissions,
    gnuDebugLink: image.gnuDebugLink,
    debugInfo: roleAvailability(image.candidates, ".debug_info"),
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

const finishLines = (
  image: ImageIdentity<DwarfLineSectionRole>,
): LocatedDwarfLineImage => {
  const { sections, omissions, chosen } = selectSections(
    image,
    DWARF_LINE_SECTION_ROLES,
  );
  const line = chosen.get(".debug_line");
  return {
    format: image.format,
    bits: image.bits,
    byte_order: image.byte_order,
    machine: image.machine,
    architecture: image.architecture,
    sections,
    omissions,
    gnuDebugLink: image.gnuDebugLink,
    debugLine: roleAvailability(image.candidates, ".debug_line"),
    line: line?.bytes ?? null,
    lineStr: chosen.get(".debug_line_str")?.bytes ?? null,
    str: chosen.get(".debug_str")?.bytes ?? null,
    strOffsets: chosen.get(".debug_str_offsets")?.bytes ?? null,
    lineFileOffset:
      line === undefined || line.compression !== "none" ? null : line.offset,
    lineCompressed: line !== undefined && line.compression !== "none",
    unappliedLineRelocations: image.unappliedLineRelocations,
    unappliedDebugRelocations: image.unappliedDebugRelocations,
  };
};

const SPLIT_DEBUG_LINE = ".debug_line.dwo";

const locateElf = <Role extends AnyDwarfRole>(
  bytes: Buffer,
  budget: InflateBudget,
  roles: ReadonlySet<string>,
): ImageIdentity<Role> => {
  const directory = readElfDirectoryFromBuffer(bytes);
  if (directory.section_names_limitation !== undefined)
    throw new BinaryFormatFailure(
      "unsupported",
      directory.section_names_limitation,
    );
  let gnuDebugLink = false;
  const candidates: Candidate<Role>[] = [];
  const relocations = new Set<string>();
  const lineRelocations = new Set<string>();
  const satisfied = new Set<Role>();
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
      relocationTarget.name !== null
    ) {
      const normalizedTarget = normalizeObjectSectionName(
        relocationTarget.name,
      );
      if (normalizedTarget.startsWith(".debug_")) {
        relocations.add(section.name);
        if (LINE_ROLES.has(normalizedTarget)) lineRelocations.add(section.name);
      }
    }
    if (
      roles.has(".debug_info") &&
      normalizeObjectSectionName(section.name) === SPLIT_DEBUG_INFO
    ) {
      candidates.push(
        unread(
          section.name,
          ".debug_info" as Role,
          "unreadable",
          `Split DWARF section ${section.name} is not read`,
        ),
      );
      continue;
    }
    if (
      roles.has(".debug_line") &&
      normalizeObjectSectionName(section.name) === SPLIT_DEBUG_LINE
    ) {
      candidates.push(
        unread(
          section.name,
          ".debug_line" as Role,
          "unreadable",
          `Split DWARF section ${section.name} is not read`,
        ),
      );
      continue;
    }
    const role = objectSectionRole<Role>(section.name, roles);
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
    unappliedLineRelocations: [...lineRelocations],
  };
};

const adoptStored = <Role extends AnyDwarfRole>(
  name: string,
  role: Role,
  offset: number,
  size: number,
  stored: Buffer,
  budget: InflateBudget,
  satisfied: Set<Role>,
  subject: string,
): Candidate<Role> => {
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

const locatePe = <Role extends AnyDwarfRole>(
  bytes: Buffer,
  budget: InflateBudget,
  roles: ReadonlySet<string>,
): ImageIdentity<Role> => {
  const directory = readPeDirectory(bytes);
  const names = peSectionNames(bytes, directory);
  const candidates: Candidate<Role>[] = [];
  const satisfied = new Set<Role>();
  for (const section of directory.sections) {
    const name = names.get(section.index);
    if (name === undefined) continue;
    const role = objectSectionRole<Role>(name, roles);
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
    unappliedLineRelocations: [],
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
    const tableSize = new BinaryReader(bytes, true, "pe").u32(table);
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

const locateMacho = <Role extends AnyDwarfRole>(
  bytes: Buffer,
  budget: InflateBudget,
  roles: ReadonlySet<string>,
): ImageIdentity<Role> => {
  const image = readMachoImage(bytes);
  const candidates: Candidate<Role>[] = [];
  const satisfied = new Set<Role>();
  for (const section of image.sections) {
    if (section.format !== "macho") continue;
    if (!section.name.startsWith(MACHO_DWARF_SEGMENT)) continue;
    const role = machoSectionRole<Role>(section.section_name, roles);
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
    unappliedLineRelocations: [],
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
