import type { ManagedParseIssue } from "../domain/managedArtifact.js";
import {
  managedFailure,
  ManagedReaderFailure,
} from "./ManagedReaderFailure.js";

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

export interface ManagedPeLayout {
  readonly machine: number;
  readonly architecture: "x86" | "x86_64" | "arm" | "arm64";
  readonly optionalHeader: "pe32" | "pe32-plus";
  readonly sectionCount: number;
  readonly characteristics: number;
  readonly sections: readonly PeSection[];
  readonly cli: ManagedCliHeader | null;
  readonly cliDirectoryPresent: boolean;
  readonly cliIssue: ManagedParseIssue | null;
  rvaToOffset(rva: number, size: number, scope: string): number;
}

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

const architectureFor = (machine: number): ManagedPeLayout["architecture"] => {
  switch (machine) {
    case 0x014c:
      return "x86";
    case 0x8664:
      return "x86_64";
    case 0x01c0:
      return "arm";
    case 0xaa64:
      return "arm64";
    default:
      throw managedFailure(
        "invalid-directory",
        "pe.machine",
        `Unsupported PE machine 0x${machine.toString(16).padStart(4, "0")}`,
      );
  }
};

const mapRva = (
  bytes: Buffer,
  sections: readonly PeSection[],
  rva: number,
  size: number,
  scope: string,
): number => {
  if (rva === 0 && size === 0) return 0;
  for (const section of sections) {
    const mappedSize = Math.max(section.virtualSize, section.rawSize);
    if (rva < section.virtualAddress) continue;
    const within = rva - section.virtualAddress;
    if (within > mappedSize || size > mappedSize - within) continue;
    if (within > section.rawSize || size > section.rawSize - within)
      throw managedFailure(
        "invalid-directory",
        scope,
        `${scope} occupies virtual bytes without file-backed data`,
      );
    const offset = add(section.rawOffset, within, scope);
    requireRange(bytes, offset, size, scope);
    return offset;
  }
  throw managedFailure(
    "invalid-directory",
    scope,
    `${scope} RVA is not covered by a PE section`,
  );
};

const readDirectory = (bytes: Buffer, offset: number): PeDataDirectory => {
  requireRange(bytes, offset, 8, "pe.data-directory");
  return {
    rva: bytes.readUInt32LE(offset),
    size: bytes.readUInt32LE(offset + 4),
  };
};

const readCliHeader = (
  bytes: Buffer,
  sections: readonly PeSection[],
  directory: PeDataDirectory,
): ManagedCliHeader => {
  if (directory.size < 72)
    throw managedFailure(
      "invalid-cli-header",
      "cli.header",
      "CLI header is shorter than the required 72 bytes",
    );
  const offset = mapRva(bytes, sections, directory.rva, 72, "cli.header");
  const headerSize = bytes.readUInt32LE(offset);
  if (headerSize < 72 || headerSize > directory.size)
    throw managedFailure(
      "invalid-cli-header",
      "cli.header",
      "CLI header size is outside its PE data directory",
      offset,
    );
  const metadata = readDirectory(bytes, offset + 8);
  if (metadata.rva === 0 || metadata.size === 0)
    throw managedFailure(
      "invalid-cli-header",
      "cli.metadata",
      "CLI metadata directory is absent",
      offset + 8,
    );
  const flags = bytes.readUInt32LE(offset + 16);
  const managedNativeHeader = readDirectory(bytes, offset + 64);
  let readyToRunSignature = false;
  if (managedNativeHeader.rva !== 0 && managedNativeHeader.size >= 4) {
    const nativeOffset = mapRva(
      bytes,
      sections,
      managedNativeHeader.rva,
      4,
      "cli.managed-native-header",
    );
    readyToRunSignature = bytes.readUInt32LE(nativeOffset) === 0x0052_5452;
  }
  return {
    headerOffset: offset,
    headerSize,
    runtimeMajor: bytes.readUInt16LE(offset + 4),
    runtimeMinor: bytes.readUInt16LE(offset + 6),
    metadata,
    flags,
    entryPoint: bytes.readUInt32LE(offset + 20),
    resources: readDirectory(bytes, offset + 24),
    strongName: readDirectory(bytes, offset + 32),
    managedNativeHeader,
    readyToRunSignature,
  };
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
  const peOffset = bytes.readUInt32LE(0x3c);
  requireRange(bytes, peOffset, 24, "pe.coff-header");
  if (bytes.readUInt32LE(peOffset) !== 0x0000_4550)
    throw managedFailure(
      "invalid-directory",
      "pe.signature",
      "PE signature is invalid",
      peOffset,
    );
  const coff = peOffset + 4;
  const machine = bytes.readUInt16LE(coff);
  const sectionCount = bytes.readUInt16LE(coff + 2);
  if (sectionCount === 0 || sectionCount > 96)
    throw managedFailure(
      "invalid-directory",
      "pe.sections",
      "PE section count is outside the admitted range",
      coff + 2,
    );
  const optionalSize = bytes.readUInt16LE(coff + 16);
  const characteristics = bytes.readUInt16LE(coff + 18);
  const optionalOffset = coff + 20;
  requireRange(bytes, optionalOffset, optionalSize, "pe.optional-header");
  if (optionalSize < 96)
    throw managedFailure(
      "invalid-directory",
      "pe.optional-header",
      "PE optional header is too short",
      optionalOffset,
    );
  const magic = bytes.readUInt16LE(optionalOffset);
  const optionalHeader =
    magic === 0x010b ? "pe32" : magic === 0x020b ? "pe32-plus" : undefined;
  if (optionalHeader === undefined)
    throw managedFailure(
      "invalid-directory",
      "pe.optional-header",
      "PE optional header magic is unsupported",
      optionalOffset,
    );
  const directoryCountOffset =
    optionalOffset + (optionalHeader === "pe32" ? 92 : 108);
  const directoryOffset =
    optionalOffset + (optionalHeader === "pe32" ? 96 : 112);
  requireRange(bytes, directoryCountOffset, 4, "pe.data-directories");
  const directoryCount = bytes.readUInt32LE(directoryCountOffset);
  const sectionOffset = add(optionalOffset, optionalSize, "pe.sections");
  requireRange(bytes, sectionOffset, sectionCount * 40, "pe.sections");
  const sections: PeSection[] = [];
  for (let index = 0; index < sectionCount; index += 1) {
    const offset = sectionOffset + index * 40;
    const section = {
      virtualSize: bytes.readUInt32LE(offset + 8),
      virtualAddress: bytes.readUInt32LE(offset + 12),
      rawSize: bytes.readUInt32LE(offset + 16),
      rawOffset: bytes.readUInt32LE(offset + 20),
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
  const cliDirectory =
    directoryCount <= 14 ||
    optionalSize < directoryOffset - optionalOffset + 120
      ? { rva: 0, size: 0 }
      : readDirectory(bytes, directoryOffset + 14 * 8);
  const cliDirectoryPresent = cliDirectory.rva !== 0 || cliDirectory.size !== 0;
  let cli: ManagedCliHeader | null = null;
  let cliIssue: ManagedParseIssue | null = null;
  if (cliDirectoryPresent)
    try {
      cli = readCliHeader(bytes, sections, cliDirectory);
    } catch (cause: unknown) {
      if (!(cause instanceof ManagedReaderFailure)) throw cause;
      cliIssue = cause.issue;
    }
  return {
    machine,
    architecture: architectureFor(machine),
    optionalHeader,
    sectionCount,
    characteristics,
    sections,
    cli,
    cliDirectoryPresent,
    cliIssue,
    rvaToOffset: (rva, size, scope) =>
      mapRva(bytes, sections, rva, size, scope),
  };
};
