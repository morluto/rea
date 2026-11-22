import { indexPeSectionRvas } from "../pe/peSectionRvaIndex.js";
import { BinaryReader } from "../binaryContainer.js";
import { observeMzWindowsHeader } from "../dosMz.js";
import {
  PE_SIZE_OF_HEADERS_OFFSET,
  readPeOptionalHeaderFixedFields,
  readPeOptionalHeaderDirectory,
  type PeOptionalHeaderFixedFields,
} from "../peOptionalHeader.js";
import {
  observePeHeaderExtent,
  PE_SECTION_HEADER_BYTES,
  readPeSectionHeader,
} from "../peSectionHeader.js";
import type { ManagedParseIssue } from "./managedArtifact.js";
import { readPeCoffHeader } from "../peCoffHeader.js";
import { decodePeMachine } from "../peMachine.js";
import { readManagedCliHeaderPrefix } from "./managedCliHeaderPrefix.js";
import {
  managedFailure,
  ManagedReaderFailure,
} from "./managedReaderFailure.js";

interface PeSection {
  readonly virtualAddress: number;
  readonly virtualSize: number;
  readonly rawOffset: number;
  readonly rawSize: number;
}

interface PeDataDirectory {
  readonly rva: number;
  readonly size: number;
}

export interface ManagedCliHeader {
  readonly headerOffset: number;
  readonly headerSize: number;
  readonly runtimeMajor: number;
  readonly runtimeMinor: number;
  readonly metadata: PeDataDirectory;
  readonly flags: number;
  readonly entryPoint: number;
  readonly resources: PeDataDirectory;
  readonly strongName: PeDataDirectory;
  readonly managedNativeHeader: PeDataDirectory;
  readonly readyToRunSignature: boolean;
}

/**
 * How the CLI header constrains process bitness. 32BITREQUIRED and
 * 32BITPREFERRED are one two-bit field: required alone is x86-only, both set
 * is platform-neutral code that prefers a 32-bit process, and preferred alone
 * is reserved and constrains nothing.
 */
export const managedCli32BitRequirement = (
  flags: number,
): "required" | "preferred" | "none" => {
  const pair = flags & 0x0002_0002;
  if (pair === 0x0000_0002) return "required";
  return pair === 0x0002_0002 ? "preferred" : "none";
};

/**
 * crossgen2 clears ILONLY on ReadyToRun output, so only a clear ILONLY flag
 * without the ReadyToRun signature marks mixed CLR/native code.
 */
export const managedCliIsMixedClrNative = (cli: ManagedCliHeader): boolean =>
  (cli.flags & 0x0000_0001) === 0 && !cli.readyToRunSignature;

export interface ManagedPeLayout {
  readonly machine: number;
  readonly architecture: "x86" | "x86_64" | "arm" | "arm64";
  readonly optionalHeader: "pe32" | "pe32-plus";
  readonly sectionCount: number;
  readonly characteristics: number;
  readonly sections: readonly PeSection[];
  readonly cli: ManagedCliHeader | null;
  readonly cliDirectoryState: "absent" | "present" | "unreadable";
  readonly cliIssue: ManagedParseIssue | null;
  rvaToOffset(rva: number, size: number, scope: string): number;
  rvaFileRange(
    rva: number,
    scope: string,
  ): { readonly offset: number; readonly available: number };
}

interface RvaMapping {
  readonly bytes: Buffer;
  readonly lookup: ReturnType<typeof indexPeSectionRvas<PeSection>>;
  readonly rva: number;
  readonly size: number;
  readonly scope: string;
}

interface CoffHeader {
  readonly coff: number;
  readonly machine: number;
  readonly sectionCount: number;
  readonly optionalSize: number;
  readonly characteristics: number;
}

interface OptionalHeader {
  readonly optionalOffset: number;
  readonly optionalHeader: "pe32" | "pe32-plus";
  readonly fixed: PeOptionalHeaderFixedFields;
}

type CliDirectoryRead =
  | { readonly kind: "absent" }
  | { readonly kind: "present"; readonly directory: PeDataDirectory }
  | { readonly kind: "unreadable"; readonly issue: ManagedParseIssue };

const requireRange = (
  bytes: Buffer,
  offset: number,
  length: number,
  scope: string,
): void => {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset > bytes.length - length
  )
    throw managedFailure(
      "invalid-directory",
      scope,
      `${scope} leaves the artifact byte range`,
      Number.isSafeInteger(offset) && offset >= 0 ? offset : null,
    );
};

const add = (left: number, right: number, scope: string): number => {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < left)
    throw managedFailure(
      "invalid-directory",
      scope,
      `${scope} offset arithmetic overflowed`,
      left,
    );
  return result;
};

const architectureFor = (
  machine: number,
  managed: boolean,
): ManagedPeLayout["architecture"] => {
  const decoded = decodePeMachine(machine);
  if (decoded === undefined || (decoded.nativeOsOverride && !managed))
    throw managedFailure(
      "invalid-directory",
      "pe.machine",
      `Unsupported PE machine 0x${machine.toString(16).padStart(4, "0")}`,
    );
  return decoded.architecture;
};

/** Resolve one section identity for both exact reads and available-byte queries. */
const resolveRva = (
  mapping: RvaMapping,
): { readonly offset: number; readonly available: number } => {
  const { bytes, lookup, rva, size, scope } = mapping;
  if (
    !Number.isSafeInteger(rva) ||
    !Number.isSafeInteger(size) ||
    rva < 0 ||
    size < 0 ||
    rva > 0xffff_ffff ||
    (size > 0 && size > 0x1_0000_0000 - rva)
  )
    throw managedFailure(
      "invalid-directory",
      scope,
      `${scope} has an invalid RVA range`,
    );
  // VirtualSize owns RVA containment; raw size also includes alignment padding.
  const { section: owned, overlaps, nextStart } = lookup(rva);
  if (owned === undefined || rva + size > owned.end)
    throw managedFailure(
      "invalid-directory",
      scope,
      `${scope} RVA is not covered by one PE section`,
    );
  if (overlaps || nextStart < rva + size)
    throw managedFailure(
      "invalid-directory",
      scope,
      `${scope} RVA range has ambiguous overlapping PE section mappings`,
    );
  const selected = owned.section;
  const within = rva - selected.virtualAddress;
  if (within > selected.rawSize || size > selected.rawSize - within)
    throw managedFailure(
      "invalid-directory",
      scope,
      `${scope} occupies virtual bytes without file-backed data`,
    );
  const offset = add(selected.rawOffset, within, scope);
  requireRange(bytes, offset, size, scope);
  const available = Math.min(
    selected.virtualSize - within,
    selected.rawSize - within,
    bytes.length - offset,
    0x1_0000_0000 - rva,
    nextStart - rva,
  );
  return { offset, available };
};

const mapRva = (mapping: RvaMapping): number =>
  mapping.rva === 0 && mapping.size === 0 ? 0 : resolveRva(mapping).offset;

const readDirectory = (
  reader: BinaryReader,
  offset: number,
): PeDataDirectory => {
  requireRange(reader.bytes, offset, 8, "pe.data-directory");
  return {
    rva: reader.u32(offset),
    size: reader.u32(offset + 4),
  };
};

const readCliHeader = (
  bytes: Buffer,
  lookup: RvaMapping["lookup"],
  directory: PeDataDirectory,
): ManagedCliHeader => {
  if (directory.size < 72)
    throw managedFailure(
      "invalid-cli-header",
      "cli.header",
      "CLI header is shorter than the required 72 bytes",
    );
  const offset = mapRva({
    bytes,
    lookup,
    rva: directory.rva,
    size: 16,
    scope: "cli.header",
  });
  const prefix = readManagedCliHeaderPrefix(
    bytes.subarray(offset, offset + 16),
  );
  if (!prefix.ok)
    throw managedFailure(
      "invalid-cli-header",
      "cli.header",
      prefix.error.message,
      offset,
    );
  const { headerSize, runtimeMajor, runtimeMinor, metadata } = prefix.value;
  if (headerSize < 72 || headerSize > directory.size)
    throw managedFailure(
      "invalid-cli-header",
      "cli.header",
      "CLI header size is outside its PE data directory",
      offset,
    );
  // cb owns the complete header extent, including opaque backed extensions.
  // Admit it before reading remaining fields or publishing a location range.
  mapRva({
    bytes,
    lookup,
    rva: directory.rva,
    size: headerSize,
    scope: "cli.header",
  });
  if (metadata.rva === 0 || metadata.size === 0)
    throw managedFailure(
      "invalid-cli-header",
      "cli.metadata",
      "CLI metadata directory is absent",
      offset + 8,
    );
  const reader = new BinaryReader(bytes, true, "managed-pe");
  const flags = reader.u32(offset + 16);
  const managedNativeHeader = readDirectory(reader, offset + 64);
  let readyToRunSignature = false;
  if (managedNativeHeader.rva !== 0 && managedNativeHeader.size >= 4) {
    const nativeOffset = mapRva({
      bytes,
      lookup,
      rva: managedNativeHeader.rva,
      size: 4,
      scope: "cli.managed-native-header",
    });
    readyToRunSignature = reader.u32(nativeOffset) === 0x0052_5452;
  }
  return {
    headerOffset: offset,
    headerSize,
    runtimeMajor,
    runtimeMinor,
    metadata,
    flags,
    entryPoint: reader.u32(offset + 20),
    resources: readDirectory(reader, offset + 24),
    strongName: readDirectory(reader, offset + 32),
    managedNativeHeader,
    readyToRunSignature,
  };
};

const readCoffHeader = (bytes: Buffer): CoffHeader => {
  const observed = observeMzWindowsHeader(bytes);
  if (observed.state === "candidate" || observed.state === "signature-needed")
    requireRange(bytes, observed.offset, 24, "pe.coff-header");
  if (observed.state !== "declared" || observed.signature !== "PE")
    throw managedFailure(
      "invalid-directory",
      "pe.signature",
      "MZ header does not declare a PE image",
      0x3c,
    );
  const peOffset = observed.offset;
  requireRange(bytes, peOffset, 24, "pe.coff-header");
  const coff = peOffset + 4;
  const parsed = readPeCoffHeader(bytes.subarray(coff, coff + 20));
  if (!parsed.ok)
    throw managedFailure(
      "invalid-directory",
      "pe.coff-header",
      parsed.error.message,
      peOffset,
    );
  const {
    machine,
    sectionCount,
    optionalHeaderSize: optionalSize,
    characteristics,
  } = parsed.value;
  if (sectionCount === 0)
    throw managedFailure(
      "invalid-directory",
      "pe.sections",
      "PE section count must be positive",
      coff + 2,
    );
  return { coff, machine, sectionCount, optionalSize, characteristics };
};

const readOptionalHeader = (
  bytes: Buffer,
  coff: CoffHeader,
): OptionalHeader => {
  const optionalOffset = coff.coff + 20;
  requireRange(bytes, optionalOffset, coff.optionalSize, "pe.optional-header");
  if (coff.optionalSize < 96)
    throw managedFailure(
      "invalid-directory",
      "pe.optional-header",
      "PE optional header is too short",
      optionalOffset,
    );
  const parsed = readPeOptionalHeaderFixedFields(
    bytes.subarray(optionalOffset, optionalOffset + coff.optionalSize),
  );
  if (!parsed.ok)
    throw managedFailure(
      "invalid-directory",
      "pe.optional-header",
      "PE optional header magic is unsupported",
      optionalOffset,
    );
  return {
    optionalOffset,
    optionalHeader: parsed.value.format,
    fixed: parsed.value,
  };
};

const readSections = (
  bytes: Buffer,
  sectionTableOffset: number,
  sectionCount: number,
): readonly PeSection[] => {
  const sections: PeSection[] = [];
  for (let index = 0; index < sectionCount; index += 1) {
    const offset = sectionTableOffset + index * PE_SECTION_HEADER_BYTES;
    const parsed = readPeSectionHeader(
      bytes.subarray(offset, offset + PE_SECTION_HEADER_BYTES),
    );
    if (!parsed.ok)
      throw managedFailure(
        "invalid-directory",
        "pe.sections",
        parsed.error.message,
        offset,
      );
    const section = {
      virtualSize: parsed.value.virtual_size,
      virtualAddress: parsed.value.virtual_address,
      rawSize: parsed.value.raw_size,
      rawOffset: parsed.value.offset,
    };
    if (section.rawSize > 0)
      requireRange(
        bytes,
        section.rawOffset,
        section.rawSize,
        "pe.section-data",
      );
    sections.push(section);
  }
  return sections;
};

const readCliDirectory = (
  bytes: Buffer,
  coff: CoffHeader,
  optional: OptionalHeader,
): CliDirectoryRead => {
  const observed = readPeOptionalHeaderDirectory(
    bytes.subarray(
      optional.optionalOffset,
      optional.optionalOffset + coff.optionalSize,
    ),
    optional.fixed,
    14,
  );
  const countOffset =
    optional.optionalOffset + optional.fixed.directoryCountOffset;
  if (observed.state === "count-unavailable")
    return {
      kind: "unreadable",
      issue: {
        code: "invalid-directory",
        scope: "pe.optional-header",
        detail: "PE optional header does not contain its directory count",
        offset: countOffset,
      },
    };
  if (observed.state === "absent") return { kind: "absent" };
  if (observed.state === "truncated")
    return {
      kind: "unreadable",
      issue: {
        code: "invalid-directory",
        scope: "pe.data-directories",
        detail: "PE data-directory count exceeds the optional-header extent",
        offset: countOffset,
      },
    };
  const directory = {
    rva: observed.directory.address,
    size: observed.directory.size,
  };
  return directory.rva !== 0 || directory.size !== 0
    ? { kind: "present", directory }
    : { kind: "absent" };
};

/** Parse the file-backed PE and CLI layout without loading target code. */
export const readManagedPeLayout = (bytes: Buffer): ManagedPeLayout => {
  requireRange(bytes, 0, 64, "pe.dos-header");
  if (bytes[0] !== 0x4d || bytes[1] !== 0x5a)
    throw managedFailure(
      "invalid-directory",
      "pe.dos-header",
      "Artifact does not start with an MZ header",
      0,
    );
  const coff = readCoffHeader(bytes);
  const optional = readOptionalHeader(bytes, coff);
  const { sectionTableOffset, sectionTableBytes, sizeOfHeadersState } =
    observePeHeaderExtent({
      optionalHeaderOffset: optional.optionalOffset,
      optionalHeaderSize: coff.optionalSize,
      sectionCount: coff.sectionCount,
      sizeOfHeaders: optional.fixed.sizeOfHeaders,
      fileSize: bytes.length,
    });
  requireRange(bytes, sectionTableOffset, sectionTableBytes, "pe.sections");
  const extentIssue: ManagedParseIssue | null =
    sizeOfHeadersState === "valid"
      ? null
      : {
          code: "invalid-directory",
          scope: "pe.optional-header",
          detail:
            sizeOfHeadersState === "before-section-table-end"
              ? "PE SizeOfHeaders ends before the section table ends"
              : "PE SizeOfHeaders extends past the end of the file",
          offset: optional.optionalOffset + PE_SIZE_OF_HEADERS_OFFSET,
        };
  // Retain the header and any CLI declaration we can observe, but admit no
  // RVA mappings from a section table outside a valid header envelope.
  const sections =
    extentIssue === null
      ? readSections(bytes, sectionTableOffset, coff.sectionCount)
      : [];
  const lookup = indexPeSectionRvas(
    sections.map((section) => ({
      start: section.virtualAddress,
      end: section.virtualAddress + section.virtualSize,
      section,
    })),
  );
  const cliDirectoryRead = readCliDirectory(bytes, coff, optional);
  const cliDirectoryState =
    extentIssue !== null && cliDirectoryRead.kind === "absent"
      ? "unreadable"
      : cliDirectoryRead.kind;
  let cli: ManagedCliHeader | null = null;
  let cliIssue =
    extentIssue ??
    (cliDirectoryRead.kind === "unreadable" ? cliDirectoryRead.issue : null);
  if (cliIssue === null && cliDirectoryRead.kind === "present") {
    try {
      cli = readCliHeader(bytes, lookup, cliDirectoryRead.directory);
    } catch (cause: unknown) {
      if (!(cause instanceof ManagedReaderFailure)) throw cause;
      cliIssue = cause.issue;
    }
  }
  return {
    machine: coff.machine,
    architecture: architectureFor(coff.machine, cliDirectoryState !== "absent"),
    optionalHeader: optional.optionalHeader,
    sectionCount: coff.sectionCount,
    characteristics: coff.characteristics,
    sections,
    cli,
    cliDirectoryState,
    cliIssue,
    rvaToOffset: (rva, size, scope) =>
      mapRva({ bytes, lookup, rva, size, scope }),
    rvaFileRange: (rva, scope) =>
      resolveRva({
        bytes,
        lookup,
        rva,
        size: 1,
        scope,
      }),
  };
};
