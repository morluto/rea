import type { FileHandle } from "node:fs/promises";
import type {
  ArmElfMetadata,
  ArmIsaExtensionDeclaration,
} from "../domain/binaryTargetTypes.js";
import { BinaryReader } from "../domain/binaryContainer.js";
import { err, ok, type Result } from "../domain/result.js";

/** Observed AEABI declarations and coverage of their source tables. */
export interface ArmElfAttributesInspection {
  readonly cpuArch: number | null;
  readonly cpuArchProfile: string | null;
  /** Declared Tag_DIV_use and Tag_Virtualization_use pairs, in payload order. */
  readonly extensions: readonly ArmIsaExtensionDeclaration[];
  readonly limitations: readonly string[];
}

/** SHT_ARM_ATTRIBUTES carries the AEABI declarations for an ELF32 ARM image. */
const SHT_ARM_ATTRIBUTES = 0x70000003;
const ARM_ATTRIBUTES_MAX_BYTES = 65536;
const ARM_ATTRIBUTES_MAX_TAGS = 4096;
/** Tag_CPU_arch (6) and Tag_CPU_arch_profile (7), a one-byte character. */
const TAG_CPU_ARCH = 6;
const TAG_CPU_ARCH_PROFILE = 7;
/** Tag_DIV_use (44) and Tag_Virtualization_use (68) declare ISA extensions. */
const ISA_EXTENSION_TAGS = new Set([44, 68]);

/** Read one ULEB128 value; null on truncation or an over-long encoding. */
const readUleb128 = (
  bytes: Buffer,
  start: number,
  end: number,
): { value: number; next: number } | null => {
  let value = 0;
  let shift = 0;
  let cursor = start;
  while (cursor < end && shift <= 28) {
    const byte = bytes[cursor];
    if (byte === undefined) return null;
    cursor += 1;
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return { value, next: cursor };
    shift += 7;
  }
  return null;
};

const skipAttributesString = (
  bytes: Buffer,
  start: number,
  end: number,
): number | null => {
  const terminator = bytes.indexOf(0, start);
  return terminator < 0 || terminator >= end ? null : terminator + 1;
};

/** AEABI declarations read from one attributes payload. */
interface AeabiDeclarations {
  readonly observed: {
    readonly cpuArch: number | null;
    readonly cpuArchProfile: string | null;
  };
  readonly cpuArch: number | null;
  readonly cpuArchProfile: string | null;
  /** ISA-extension declarations from every scope; any scope can enable one. */
  readonly extensions: readonly ArmIsaExtensionDeclaration[];
  /**
   * A Section or Symbol scope, or a repeated File scope, declared an ISA or
   * profile that disagrees with the File-scope declaration; the payload then
   * reads as no declaration instead of proof of the last writer.
   */
  readonly declarationConflict: boolean;
}

const NO_AEABI_DECLARATIONS: AeabiDeclarations = {
  observed: { cpuArch: null, cpuArchProfile: null },
  cpuArch: null,
  cpuArchProfile: null,
  extensions: [],
  declarationConflict: false,
};

/**
 * Walk one scope block's tag/value pairs. Scope tags cannot nest, Tag_NULL is
 * not a valid attribute boundary, Tag_nodefaults (64) carries an ignored ULEB
 * value, tags
 * 4, 5, and 32 carry strings, odd tags above 32 carry NUL-terminated strings
 * such as Tag_also_compatible_with, and every other declared tag carries one
 * ULEB value. Repeated ISA or profile tags must agree.
 */
const scanAeabiScope = (
  section: Buffer,
  start: number,
  end: number,
):
  | (Pick<AeabiDeclarations, "cpuArch" | "cpuArchProfile" | "extensions"> & {
      readonly repeatedDeclarationConflicts: boolean;
    })
  | null => {
  let cursor = start;
  let cpuArch: number | null = null;
  let cpuArchProfile: string | null = null;
  const extensions: ArmIsaExtensionDeclaration[] = [];
  let conflict = false;
  let tags = 0;
  while (cursor < end) {
    if ((tags += 1) > ARM_ATTRIBUTES_MAX_TAGS) return null;
    const tag = readUleb128(section, cursor, end);
    if (tag === null) return null;
    cursor = tag.next;
    if (tag.value === TAG_CPU_ARCH || tag.value === TAG_CPU_ARCH_PROFILE) {
      const value = readUleb128(section, cursor, end);
      if (value === null) return null;
      cursor = value.next;
      if (tag.value === TAG_CPU_ARCH) {
        if (cpuArch !== null && cpuArch !== value.value) conflict = true;
        cpuArch = value.value;
      } else if (value.value > 127) return null;
      else {
        const profile = String.fromCharCode(value.value);
        if (cpuArchProfile !== null && cpuArchProfile !== profile)
          conflict = true;
        cpuArchProfile = profile;
      }
      continue;
    }
    if (tag.value === 0 || (tag.value >= 1 && tag.value <= 3)) return null;
    if (tag.value === 32) {
      const compatibility = readUleb128(section, cursor, end);
      if (compatibility === null) return null;
      const next = skipAttributesString(section, compatibility.next, end);
      if (next === null) return null;
      cursor = next;
      continue;
    }
    if (tag.value === 4 || tag.value === 5) {
      const next = skipAttributesString(section, cursor, end);
      if (next === null) return null;
      cursor = next;
      continue;
    }
    if (tag.value > 32 && tag.value % 2 === 1) {
      const next = skipAttributesString(section, cursor, end);
      if (next === null) return null;
      cursor = next;
      continue;
    }
    const value = readUleb128(section, cursor, end);
    if (value === null) return null;
    cursor = value.next;
    if (ISA_EXTENSION_TAGS.has(tag.value))
      extensions.push({ tag: tag.value, value: value.value });
  }
  return {
    cpuArch,
    cpuArchProfile,
    extensions,
    repeatedDeclarationConflicts: conflict,
  };
};

/** Skip a scope's NUL-terminated ULEB128 index list; the tags follow it. */
const skipAeabiIndices = (
  section: Buffer,
  start: number,
  end: number,
): number | null => {
  let cursor = start;
  for (;;) {
    const index = readUleb128(section, cursor, end);
    if (index === null) return null;
    if (index.value === 0) return index.next;
    cursor = index.next;
  }
};

/**
 * Walk one aeabi subsection's length-delimited scope blocks. File scopes carry
 * the primary declaration and must agree when repeated; Section and Symbol
 * scopes can refine declarations per region or symbol, so a disagreement with
 * the File scope is a conflict rather than an override.
 */
const aeabiDeclarations = (
  section: Buffer,
  start: number,
  end: number,
): AeabiDeclarations | null => {
  let cursor = start;
  let declarations: Pick<AeabiDeclarations, "cpuArch" | "cpuArchProfile"> =
    NO_AEABI_DECLARATIONS;
  let allDeclarations: Pick<AeabiDeclarations, "cpuArch" | "cpuArchProfile"> =
    NO_AEABI_DECLARATIONS;
  const extensions: ArmIsaExtensionDeclaration[] = [];
  let conflict = false;
  const disagrees = (
    scanned: Pick<AeabiDeclarations, "cpuArch" | "cpuArchProfile">,
  ): boolean =>
    (scanned.cpuArch !== null &&
      allDeclarations.cpuArch !== null &&
      scanned.cpuArch !== allDeclarations.cpuArch) ||
    (scanned.cpuArchProfile !== null &&
      allDeclarations.cpuArchProfile !== null &&
      scanned.cpuArchProfile !== allDeclarations.cpuArchProfile);
  while (cursor < end) {
    const scope = readUleb128(section, cursor, end);
    if (scope === null || scope.value < 1 || scope.value > 3) return null;
    if (scope.next + 4 > end) return null;
    const blockEnd =
      cursor +
      new BinaryReader(section, true, "ARM attributes").u32(scope.next);
    if (blockEnd < scope.next + 4 || blockEnd > end) return null;
    // Section and Symbol scopes open with a NUL-terminated ULEB128
    // index list naming the regions or symbols their tags apply to.
    const tagsStart =
      scope.value === 1
        ? scope.next + 4
        : skipAeabiIndices(section, scope.next + 4, blockEnd);
    if (tagsStart === null) return null;
    const scanned = scanAeabiScope(section, tagsStart, blockEnd);
    if (scanned === null) return null;
    if (scanned.repeatedDeclarationConflicts || disagrees(scanned))
      conflict = true;
    extensions.push(...scanned.extensions);
    allDeclarations = {
      cpuArch: scanned.cpuArch ?? allDeclarations.cpuArch,
      cpuArchProfile: scanned.cpuArchProfile ?? allDeclarations.cpuArchProfile,
    };
    if (scope.value === 1)
      declarations = {
        cpuArch: scanned.cpuArch ?? declarations.cpuArch,
        cpuArchProfile: scanned.cpuArchProfile ?? declarations.cpuArchProfile,
      };
    cursor = blockEnd;
  }
  return {
    ...declarations,
    extensions,
    observed: allDeclarations,
    declarationConflict: conflict,
  };
};

/**
 * Parse an AEABI attributes payload: 'A', then subsections of a 4-byte
 * length, a NUL-terminated owner, and length-delimited scope blocks. Only
 * the public aeabi subsections declare the architecture and must agree;
 * other owners and every malformed or conflicting shape read back as no
 * declaration.
 */
const armAttributesDeclarations = (section: Buffer): AeabiDeclarations => {
  if (section.length < 2 || section[0] !== 0x41) return NO_AEABI_DECLARATIONS;
  let cursor = 1;
  let merged: AeabiDeclarations | null = null;
  while (cursor + 4 <= section.length) {
    const subsectionEnd =
      cursor + new BinaryReader(section, true, "ARM attributes").u32(cursor);
    if (
      subsectionEnd <= cursor + 4 ||
      subsectionEnd > section.length ||
      subsectionEnd > cursor + ARM_ATTRIBUTES_MAX_BYTES
    )
      return NO_AEABI_DECLARATIONS;
    const ownerEnd = skipAttributesString(section, cursor + 4, subsectionEnd);
    if (ownerEnd === null) return NO_AEABI_DECLARATIONS;
    const owner = section.toString("binary", cursor + 4, ownerEnd - 1);
    if (owner === "aeabi") {
      // Every public subsection must agree; a later declaration is a
      // conflict, not an overwrite of the first.
      const declarations = aeabiDeclarations(section, ownerEnd, subsectionEnd);
      if (declarations === null || declarations.declarationConflict)
        return NO_AEABI_DECLARATIONS;
      if (
        merged !== null &&
        ((merged.observed.cpuArch !== null &&
          declarations.observed.cpuArch !== null &&
          merged.observed.cpuArch !== declarations.observed.cpuArch) ||
          (merged.observed.cpuArchProfile !== null &&
            declarations.observed.cpuArchProfile !== null &&
            merged.observed.cpuArchProfile !==
              declarations.observed.cpuArchProfile))
      )
        return NO_AEABI_DECLARATIONS;
      merged =
        merged === null
          ? declarations
          : {
              cpuArch: declarations.cpuArch ?? merged.cpuArch,
              cpuArchProfile:
                declarations.cpuArchProfile ?? merged.cpuArchProfile,
              extensions: [...merged.extensions, ...declarations.extensions],
              observed: {
                cpuArch:
                  declarations.observed.cpuArch ?? merged.observed.cpuArch,
                cpuArchProfile:
                  declarations.observed.cpuArchProfile ??
                  merged.observed.cpuArchProfile,
              },
              declarationConflict: false,
            };
    }
    cursor = subsectionEnd;
  }
  return cursor === section.length
    ? (merged ?? NO_AEABI_DECLARATIONS)
    : NO_AEABI_DECLARATIONS;
};

/**
 * Read Tag_CPU_arch from .ARM.attributes of the caller's already-open ELF32
 * ARM file, including sections beyond the initial header probe. A missing
 * declaration is unknown, not a default architecture; the ELF header cannot
 * establish the CPU ISA. The caller supplies its cancellation check so its
 * tagged error is preserved.
 */
export const readArmElfCpuArch = async (
  handle: FileHandle,
  metadata: ArmElfMetadata,
  checkCancelled: () => void,
): Promise<Result<ArmElfAttributesInspection, string>> => {
  checkCancelled();
  if (metadata.elfClass !== 32)
    return err("ARM attribute inspection currently supports ELF32 only");
  const fileSize = (await handle.stat()).size;
  checkCancelled();
  const read = async (
    offset: number,
    length: number,
    label: string,
  ): Promise<Result<Buffer, string>> => {
    checkCancelled();
    if (
      !Number.isSafeInteger(fileSize) ||
      offset < 0 ||
      length < 0 ||
      offset > fileSize - length
    )
      return err(`ARM ${label} lies outside the file`);
    const bytes = Buffer.alloc(length);
    let total = 0;
    while (total < length) {
      checkCancelled();
      const observed = await handle.read(
        bytes,
        total,
        length - total,
        offset + total,
      );
      checkCancelled();
      if (observed.bytesRead === 0) return err(`truncated ARM ${label}`);
      total += observed.bytesRead;
    }
    return ok(bytes);
  };
  const header = await read(0, 52, "ELF32 header");
  if (!header.ok) return header;
  const bytes = header.value;
  const little = metadata.byteOrder === "little";
  const u16 = (data: Buffer, offset: number): number =>
    new BinaryReader(data, little, "elf").u16(offset);
  const u32 = (data: Buffer, offset: number): number =>
    new BinaryReader(data, little, "elf").u32(offset);
  if (
    bytes.toString("hex", 0, 4) !== "7f454c46" ||
    bytes[4] !== 1 ||
    bytes[5] !== (little ? 1 : 2) ||
    u16(bytes, 18) !== 40 ||
    u16(bytes, 16) !== metadata.type ||
    u32(bytes, 36) !== metadata.flags
  )
    return err("ARM ELF header no longer matches the resolved identity");
  if (
    bytes[6] !== 1 ||
    u32(bytes, 20) !== 1 ||
    u16(bytes, 40) !== metadata.headerSize
  )
    return err("invalid ARM ELF32 version or header size");
  // Coverage limits belong to the attribute inspection, not target identity:
  // other providers may analyze the unchanged ARM ELF without this Ghidra pin.
  if (u16(bytes, 48) >= 0xff00)
    return ok({
      cpuArch: null,
      cpuArchProfile: null,
      extensions: [],
      limitations: [
        "Extended or reserved ARM ELF table numbering is not inspected; attribute declarations remain unknown.",
      ],
    });
  const tableOffset = u32(bytes, 32);
  const count = u16(bytes, 48);
  const stride = u16(bytes, 46);
  const limitations: string[] = [];
  if (count === 0) {
    if (tableOffset !== 0)
      return ok({
        cpuArch: null,
        cpuArchProfile: null,
        extensions: [],
        limitations: [
          "Extended ARM section numbering is not inspected; attribute declarations remain unknown.",
        ],
      });
    return ok({
      cpuArch: null,
      cpuArchProfile: null,
      extensions: [],
      limitations,
    });
  }
  // The exact ELF32 entry size bounds the table allocation by the header
  // count alone; a padded stride could multiply a sparse file into one.
  if (tableOffset < metadata.headerSize || stride !== 40)
    return err("invalid ARM section table offset or entry size");
  const examinable = Math.min(
    count,
    Math.max(0, Math.floor((fileSize - tableOffset) / stride)),
  );
  if (examinable < count)
    limitations.push(
      `ARM section header table at file offset ${tableOffset} extends beyond the captured file: examined ${examinable} of ${count} complete headers. Declarations in unavailable headers remain unknown.`,
    );
  if (examinable === 0)
    return ok({
      cpuArch: null,
      cpuArchProfile: null,
      extensions: [],
      limitations,
    });
  const contents = await read(
    tableOffset,
    examinable * stride,
    "section header table",
  );
  if (!contents.ok) return contents;
  // Structural metadata is not section content: an attributes range that
  // reaches into the ELF header or either header table cannot declare an ISA.
  const programOffset = u32(bytes, 28);
  const programExtent = u16(bytes, 42) * u16(bytes, 44);
  const structure: readonly (readonly [number, number])[] = [
    [0, metadata.headerSize],
    [tableOffset, tableOffset + count * stride],
    ...(programExtent === 0
      ? []
      : [[programOffset, programOffset + programExtent] as const]),
  ];
  const overlapsStructure = (offset: number, size: number): boolean =>
    structure.some(([start, end]) => offset < end && start < offset + size);
  const locateAttributesSection = async (): Promise<
    Result<Buffer | undefined, string>
  > => {
    let section: Buffer | undefined;
    let attributeSectionSeen = false;
    // Section zero is the reserved null entry and owns no section contents.
    for (let index = 1; index < examinable; index += 1) {
      checkCancelled();
      const position = index * stride;
      if (u32(contents.value, position + 4) !== SHT_ARM_ATTRIBUTES) continue;
      if (attributeSectionSeen)
        return err("duplicate ARM attribute sections in the section table");
      attributeSectionSeen = true;
      const offset = u32(contents.value, position + 16);
      const size = u32(contents.value, position + 20);
      if (size <= 0) return err("invalid ARM attribute section size");
      if (size > ARM_ATTRIBUTES_MAX_BYTES) {
        limitations.push(
          `ARM attribute section at file offset ${offset} exceeds the ${ARM_ATTRIBUTES_MAX_BYTES}-byte inspection bound; declarations remain unknown.`,
        );
        continue;
      }
      if (overlapsStructure(offset, size))
        return err(
          "ARM attribute section overlaps the ELF header or a header table",
        );
      const candidate = await read(offset, size, "attribute section");
      if (!candidate.ok) return candidate;
      section = candidate.value;
    }
    return ok(section);
  };
  const section = await locateAttributesSection();
  if (!section.ok) return section;
  if (section.value === undefined)
    return ok({
      cpuArch: null,
      cpuArchProfile: null,
      extensions: [],
      limitations,
    });
  // Preserve the declarations verbatim, including unknown enum values.
  // Provider admission, not parsing, decides which ISAs have been verified.
  return ok({
    ...armAttributesDeclarations(section.value),
    limitations,
  });
};
