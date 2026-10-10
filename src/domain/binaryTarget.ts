import type {
  BinaryArchitecture,
  MipsElfMetadata,
} from "./binaryTargetTypes.js";
import { err, ok, type Result } from "./result.js";
import { mzWindowsHeaderOffset, parseDosMzHeader } from "./dosMz.js";

/** Format and architecture facts recovered from an executable header. */
export type ExecutableMetadata =
  | {
      readonly format: "elf";
      readonly architecture: "mips";
      readonly availableArchitectures: readonly "mips"[];
      readonly mips: MipsElfMetadata;
    }
  | {
      readonly format: "mach-o" | "elf" | "dos-mz" | "dos-com";
      readonly architecture: Exclude<BinaryArchitecture, "mips">;
      readonly availableArchitectures: readonly Exclude<
        BinaryArchitecture,
        "mips"
      >[];
    }
  | {
      readonly format: "pe";
      readonly architecture: Exclude<BinaryArchitecture, "mips">;
      readonly availableArchitectures: readonly Exclude<
        BinaryArchitecture,
        "mips"
      >[];
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
  fileSize = bytes.length,
): Result<ExecutableMetadata, string> => {
  if (
    bytes.length >= 4 &&
    bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
  )
    return parseElf(bytes, fileSize);
  if (bytes.length >= 2 && bytes[0] === 0x4d && bytes[1] === 0x5a)
    return parseMz(bytes, fileSize);
  if (bytes.length < 8) return err("truncated or unsupported binary header");
  const magic = bytes.readUInt32BE(0);
  if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(magic))
    return parseThinMachO(bytes, magic, fileSize);
  if ([0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(magic))
    return parseFatMachO(bytes, magic, hostArchitecture, fileSize);
  return err("unsupported binary format");
};

const parseThinMachO = (
  bytes: Buffer,
  magic: number,
  fileSize: number,
): Result<ExecutableMetadata, string> => {
  const is64 = magic === 0xfeedfacf || magic === 0xcffaedfe;
  const headerSize = is64 ? 32 : 28;
  if (bytes.length < headerSize)
    return err(
      `truncated Mach-O header: a ${is64 ? 64 : 32}-bit header needs ${headerSize} bytes; the file has ${fileSize}`,
    );
  const little = magic === 0xcefaedfe || magic === 0xcffaedfe;
  const read = (offset: number): number =>
    little ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset);
  const architecture = machArchitecture(read(4));
  if (architecture === undefined) return err("unsupported Mach-O architecture");
  const commandBytes = read(20);
  if (headerSize + commandBytes > fileSize)
    return err(
      `truncated Mach-O load commands: the header declares ${commandBytes} bytes after its ${headerSize}-byte header; the file has ${fileSize}`,
    );
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
  fileSize: number,
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
  const architectures: Exclude<BinaryArchitecture, "mips">[] = [];
  const sliceEnds = new Map<BinaryArchitecture, bigint>();
  for (let index = 0; index < count; index += 1) {
    const entry = 8 + index * entrySize;
    const architecture = machArchitecture(read(entry));
    if (architecture === undefined || architectures.includes(architecture))
      continue;
    architectures.push(architecture);
    const offset = is64
      ? little
        ? bytes.readBigUInt64LE(entry + 8)
        : bytes.readBigUInt64BE(entry + 8)
      : BigInt(read(entry + 8));
    const size = is64
      ? little
        ? bytes.readBigUInt64LE(entry + 16)
        : bytes.readBigUInt64BE(entry + 16)
      : BigInt(read(entry + 12));
    sliceEnds.set(architecture, offset + size);
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
  const sliceEnd = sliceEnds.get(preferred) ?? 0n;
  if (sliceEnd > BigInt(fileSize))
    return err(
      `truncated FAT slice: the ${preferred} slice ends at byte ${sliceEnd}; the file has ${fileSize}`,
    );
  return ok({
    format: "mach-o",
    architecture: preferred,
    availableArchitectures: architectures,
  });
};

const parseElf = (
  bytes: Buffer,
  fileSize: number,
): Result<ExecutableMetadata, string> => {
  if (bytes.length < 6) return err("truncated ELF header");
  if (bytes[4] !== 1 && bytes[4] !== 2) return err("unsupported ELF class");
  const little = bytes[5] === 1;
  if (!little && bytes[5] !== 2) return err("unsupported ELF endianness");
  const headerSize = bytes[4] === 1 ? 52 : 64;
  if (bytes.length < headerSize)
    return err(
      `truncated ELF header: an ELF${bytes[4] === 1 ? 32 : 64} header needs ${headerSize} bytes; the file has ${fileSize}`,
    );
  const machine = little ? bytes.readUInt16LE(18) : bytes.readUInt16BE(18);
  const architecture = elfArchitecture(machine);
  if (architecture === undefined) return err("unsupported ELF architecture");
  if (architecture === "mips")
    return ok({
      format: "elf",
      architecture,
      availableArchitectures: [architecture],
      mips: {
        elfClass: bytes[4] === 1 ? 32 : 64,
        byteOrder: little ? "little" : "big",
        type: little ? bytes.readUInt16LE(16) : bytes.readUInt16BE(16),
        flags: little
          ? bytes.readUInt32LE(bytes[4] === 1 ? 36 : 48)
          : bytes.readUInt32BE(bytes[4] === 1 ? 36 : 48),
      },
    });
  return ok({
    format: "elf",
    architecture,
    availableArchitectures: [architecture],
  });
};

const parseMz = (
  bytes: Buffer,
  fileSize: number,
): Result<ExecutableMetadata, string> => {
  const offset = mzWindowsHeaderOffset(bytes);
  if (offset !== null) {
    if (offset < 64 || offset > bytes.length - 24)
      return err("invalid or truncated Windows executable header in MZ image");
    const signature = bytes.toString("ascii", offset, offset + 2);
    if (["NE", "LE", "LX"].includes(signature))
      return err(`unsupported ${signature} executable in MZ image`);
    return parsePeRecord(bytes.subarray(offset));
  }
  const parsed = parseDosMzHeader(bytes, fileSize);
  return parsed.ok
    ? ok({
        format: "dos-mz",
        architecture: "x86",
        availableArchitectures: ["x86"],
      })
    : parsed;
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

const machArchitecture = (
  cpu: number,
): Exclude<BinaryArchitecture, "mips"> | undefined => {
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
    case 8: // EM_MIPS: ISA, ABI and byte order remain separate ELF facts.
      return "mips";
    case 40:
      return "arm";
    case 183:
      return "arm64";
  }
  return undefined;
};

const peArchitecture = (
  machine: number,
): Exclude<BinaryArchitecture, "mips"> | undefined => {
  switch (machine) {
    case 0x14c:
      return "x86";
    case 0x8664:
      return "x86_64";
    case 0x1c0:
    case 0x1c2:
    case 0x1c4:
      return "arm";
    case 0xaa64:
      return "arm64";
  }
  return undefined;
};
