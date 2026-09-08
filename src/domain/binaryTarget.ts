import type { BinaryArchitecture } from "./binaryTargetTypes.js";
import { err, ok, type Result } from "./result.js";

export type { BinaryArchitecture, BinaryTarget } from "./binaryTargetTypes.js";

/** Format and architecture facts recovered from an executable header. */
export type ExecutableMetadata =
  | {
      readonly format: "mach-o" | "elf";
      readonly architecture: BinaryArchitecture;
      readonly availableArchitectures: readonly BinaryArchitecture[];
    }
  | {
      readonly format: "pe";
      readonly architecture: BinaryArchitecture;
      readonly availableArchitectures: readonly BinaryArchitecture[];
      readonly executableRole:
        | "application"
        | "shared-library"
        | "non-executable";
      readonly managed: boolean;
    };

/**
 * Parse supported executable headers without I/O. The caller supplies the host
 * architecture used for deterministic FAT Mach-O slice selection.
 */
export const parseExecutableHeader = (
  bytes: Buffer,
  hostArchitecture: NodeJS.Architecture,
): Result<ExecutableMetadata, string> => {
  if (
    bytes.length >= 4 &&
    bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
  )
    return parseElf(bytes);
  if (bytes.length >= 2 && bytes[0] === 0x4d && bytes[1] === 0x5a)
    return parsePe(bytes);
  if (bytes.length < 8) return err("truncated or unsupported binary header");
  const magic = bytes.readUInt32BE(0);
  if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(magic))
    return parseThinMachO(bytes, magic);
  if ([0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(magic))
    return parseFatMachO(bytes, magic, hostArchitecture);
  return err("unsupported binary format");
};

const parseThinMachO = (
  bytes: Buffer,
  magic: number,
): Result<ExecutableMetadata, string> => {
  if (bytes.length < 8) return err("truncated Mach-O header");
  const little = magic === 0xcefaedfe || magic === 0xcffaedfe;
  const architecture = machArchitecture(
    little ? bytes.readUInt32LE(4) : bytes.readUInt32BE(4),
  );
  if (architecture === undefined) return err("unsupported Mach-O architecture");
  return ok({
    format: "mach-o",
    architecture,
    availableArchitectures: [architecture],
  });
};

const parseFatMachO = (
  bytes: Buffer,
  magic: number,
  host: NodeJS.Architecture,
): Result<ExecutableMetadata, string> => {
  const little = magic === 0xbebafeca || magic === 0xbfbafeca;
  const is64 = magic === 0xcafebabf || magic === 0xbfbafeca;
  if (bytes.length < 8) return err("truncated FAT header");
  const read = (offset: number): number =>
    little ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset);
  const count = read(4);
  const entrySize = is64 ? 32 : 20;
  if (count === 0 || count > 128 || bytes.length < 8 + count * entrySize)
    return err("truncated or invalid FAT architecture table");
  const architectures: BinaryArchitecture[] = [];
  for (let index = 0; index < count; index += 1) {
    const architecture = machArchitecture(read(8 + index * entrySize));
    if (architecture !== undefined && !architectures.includes(architecture))
      architectures.push(architecture);
  }
  const preferred =
    host === "arm64"
      ? "arm64"
      : host === "x64"
        ? "x86_64"
        : host === "ia32"
          ? "x86"
          : host === "arm"
            ? "arm"
            : undefined;
  if (preferred === undefined || !architectures.includes(preferred))
    return err(`FAT binary has no host-compatible ${host} architecture`);
  return ok({
    format: "mach-o",
    architecture: preferred,
    availableArchitectures: architectures,
  });
};

const parseElf = (bytes: Buffer): Result<ExecutableMetadata, string> => {
  if (bytes.length < 20) return err("truncated ELF header");
  if (bytes[4] !== 1 && bytes[4] !== 2) return err("unsupported ELF class");
  const little = bytes[5] === 1;
  if (!little && bytes[5] !== 2) return err("unsupported ELF endianness");
  const machine = little ? bytes.readUInt16LE(18) : bytes.readUInt16BE(18);
  const architecture = elfArchitecture(machine);
  if (architecture === undefined) return err("unsupported ELF architecture");
  return ok({
    format: "elf",
    architecture,
    availableArchitectures: [architecture],
  });
};

const parsePe = (bytes: Buffer): Result<ExecutableMetadata, string> => {
  if (bytes.length < 64) return err("truncated PE DOS header");
  const offset = bytes.readUInt32LE(0x3c);
  if (offset > bytes.length - 24) return err("invalid or truncated PE header");
  return parsePeRecord(bytes.subarray(offset));
};

/** Parse a bounded PE signature, COFF record, and optional header without I/O. */
export const parsePeRecord = (
  record: Buffer,
): Result<ExecutableMetadata, string> => {
  if (
    record.length < 24 ||
    record.toString("binary", 0, 4) !== "PE\u0000\u0000"
  )
    return err("invalid or truncated PE header");
  const architecture = peArchitecture(record.readUInt16LE(4));
  if (architecture === undefined) return err("unsupported PE architecture");
  const optionalHeaderSize = record.readUInt16LE(20);
  if (optionalHeaderSize > 4096 || record.length < 24 + optionalHeaderSize)
    return err("invalid or truncated PE optional header");
  const optionalHeader = record.subarray(24, 24 + optionalHeaderSize);
  const managed = peManagedStatus(optionalHeader, architecture);
  if (!managed.ok) return managed;
  const characteristics = record.readUInt16LE(22);
  return ok({
    format: "pe",
    architecture,
    availableArchitectures: [architecture],
    executableRole:
      (characteristics & 0x0002) === 0
        ? "non-executable"
        : (characteristics & 0x2000) === 0
          ? "application"
          : "shared-library",
    managed: managed.value,
  });
};

const peManagedStatus = (
  optionalHeader: Buffer,
  architecture: BinaryArchitecture,
): Result<boolean, string> => {
  if (optionalHeader.length < 2) return err("truncated PE optional header");
  const magic = optionalHeader.readUInt16LE(0);
  const expectedMagic =
    architecture === "x86_64" || architecture === "arm64" ? 0x20b : 0x10b;
  if (magic !== expectedMagic)
    return err("PE optional-header magic does not match its architecture");
  const directoryOffset = magic === 0x20b ? 112 : 96;
  const directoryCountOffset = directoryOffset - 4;
  if (optionalHeader.length < directoryCountOffset + 4)
    return err("truncated PE optional header");
  const directoryCount = optionalHeader.readUInt32LE(directoryCountOffset);
  const requiredBytes = directoryOffset + directoryCount * 8;
  if (
    !Number.isSafeInteger(requiredBytes) ||
    requiredBytes > optionalHeader.length
  )
    return err("truncated PE data-directory table");
  if (directoryCount <= 14) return ok(false);
  const cliDirectory = directoryOffset + 14 * 8;
  return ok(
    optionalHeader.readUInt32LE(cliDirectory) !== 0 ||
      optionalHeader.readUInt32LE(cliDirectory + 4) !== 0,
  );
};

const machArchitecture = (cpu: number): BinaryArchitecture | undefined => {
  switch (cpu) {
    case 7:
      return "x86";
    case 0x01000007:
      return "x86_64";
    case 12:
      return "arm";
    case 0x0100000c:
      return "arm64";
  }
  return undefined;
};

const elfArchitecture = (machine: number): BinaryArchitecture | undefined => {
  switch (machine) {
    case 3:
      return "x86";
    case 62:
      return "x86_64";
    case 40:
      return "arm";
    case 183:
      return "arm64";
  }
  return undefined;
};

const peArchitecture = (machine: number): BinaryArchitecture | undefined => {
  switch (machine) {
    case 0x14c:
      return "x86";
    case 0x8664:
      return "x86_64";
    case 0x1c0:
      return "arm";
    case 0xaa64:
      return "arm64";
  }
  return undefined;
};
