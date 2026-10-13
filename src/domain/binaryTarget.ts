import type {
  BinaryArchitecture,
  ElfFamilyMetadata,
  HeaderArchitecture,
  MipsElfMetadata,
  RiscvElfMetadata,
  UniversalMachOSlice,
} from "./binaryTargetTypes.js";
import { err, ok, type Result } from "./result.js";
import { readElfFixedHeader } from "./elfFixedHeader.js";
import { observeMzWindowsHeader, parseDosMzHeader } from "./dosMz.js";
import { decodePeMachine } from "./peMachine.js";
import {
  classifyFatContainerIdentity,
  readFatContainerHeader,
} from "./apple/machoContainer.js";

/** Format and architecture facts recovered from an executable header. */
export type ExecutableMetadata =
  | {
      readonly format: "elf";
      readonly architecture: "mips";
      readonly availableArchitectures: readonly "mips"[];
      readonly mips: MipsElfMetadata;
    }
  | {
      readonly format: "elf";
      readonly architecture: "riscv";
      readonly availableArchitectures: readonly "riscv"[];
      readonly riscv: RiscvElfMetadata;
    }
  | {
      readonly format: "mach-o" | "elf" | "dos-mz" | "dos-com";
      readonly architecture: HeaderArchitecture;
      readonly availableArchitectures: readonly HeaderArchitecture[];
      readonly universalSlice?: never;
    }
  | {
      readonly format: "mach-o-universal";
      readonly architecture: HeaderArchitecture;
      readonly availableArchitectures: readonly HeaderArchitecture[];
      readonly universalSlice: UniversalMachOSlice;
    }
  | {
      readonly format: "pe";
      readonly architecture: HeaderArchitecture;
      readonly availableArchitectures: readonly HeaderArchitecture[];
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
  mzWindowsHeaderSignature?: Buffer,
): Result<ExecutableMetadata, string> => {
  if (
    bytes.length >= 4 &&
    bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
  )
    return parseElf(bytes, fileSize);
  if (bytes.length >= 2 && bytes[0] === 0x4d && bytes[1] === 0x5a)
    return parseMz(bytes, fileSize, mzWindowsHeaderSignature);
  if (bytes.length < 8) return err("truncated or unsupported binary header");
  const magic = bytes.readUInt32BE(0);
  if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(magic))
    return parseThinMachO(bytes, magic, fileSize);
  const fatHeader = readFatContainerHeader(bytes, fileSize);
  if (fatHeader.state !== "not-fat")
    return parseFatMachO(bytes, hostArchitecture, fatHeader);
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
  host: NodeJS.Architecture,
  header: Exclude<
    ReturnType<typeof readFatContainerHeader>,
    { state: "not-fat" }
  >,
): Result<ExecutableMetadata, string> => {
  if (header.state === "needs-data")
    return err("truncated or invalid FAT architecture table");
  if (header.state === "malformed") return err(header.reason);
  const identityError = fatIdentityError(bytes, header);
  if (identityError !== null) return err(identityError);
  const architectures: HeaderArchitecture[] = [];
  const slices = new Map<
    HeaderArchitecture,
    { readonly offset: number; readonly size: number }
  >();
  for (const declaration of header.slices) {
    const architecture = machArchitecture(declaration.cpuType);
    if (architecture === undefined || architectures.includes(architecture))
      continue;
    architectures.push(architecture);
    slices.set(architecture, {
      offset: declaration.offset,
      size: declaration.size,
    });
  }
  const preferred = fatHostArchitecture(host);
  const slice = preferred === undefined ? undefined : slices.get(preferred);
  if (preferred === undefined || slice === undefined)
    return err(`FAT binary has no host-compatible ${host} architecture`);
  const minimumHeaderSize =
    preferred === "arm64" || preferred === "x86_64" ? 32 : 28;
  if (slice.size < minimumHeaderSize)
    return err(`FAT slice for ${preferred} is shorter than its Mach-O header`);
  return ok({
    format: "mach-o-universal",
    architecture: preferred,
    availableArchitectures: architectures,
    universalSlice: { offset: slice.offset, size: slice.size },
  });
};

const fatHostArchitecture = (
  host: NodeJS.Architecture,
): HeaderArchitecture | undefined => {
  switch (host) {
    case "arm64":
      return "arm64";
    case "x64":
      return "x86_64";
    case "ia32":
      return "x86";
    case "arm":
      return "arm";
    default:
      return undefined;
  }
};

const fatIdentityError = (
  bytes: Buffer,
  header: Extract<
    ReturnType<typeof readFatContainerHeader>,
    { state: "parsed" }
  >,
): string | null => {
  const identity = classifyFatContainerIdentity(header, (offset) => {
    if (offset >= bytes.length) return undefined;
    if (offset + 4 > bytes.length) return null;
    return bytes.readUInt32BE(offset);
  });
  if (identity.state === "needs-slice-header")
    return "FAT slice identity is outside the bounded prefix";
  if (identity.state === "not-mach-o")
    return "FAT table does not identify a Mach-O image";
  if (identity.state === "malformed") return identity.reason;
  return null;
};

const parseElf = (
  bytes: Buffer,
  fileSize: number,
): Result<ExecutableMetadata, string> => {
  const fixedHeader = readElfFixedHeader(bytes, fileSize);
  if (!fixedHeader.ok) return fixedHeader;
  const { elfClass, byteOrder } = fixedHeader.value;
  const little = byteOrder === "little";
  const machine = little ? bytes.readUInt16LE(18) : bytes.readUInt16BE(18);
  const architecture = elfArchitecture(machine);
  if (architecture === undefined) return err("unsupported ELF architecture");
  if (architecture === "mips" || architecture === "riscv") {
    const flagsOffset = elfClass === 32 ? 36 : 48;
    const metadata: ElfFamilyMetadata = {
      elfClass,
      byteOrder: little ? "little" : "big",
      type: little ? bytes.readUInt16LE(16) : bytes.readUInt16BE(16),
      flags: little
        ? bytes.readUInt32LE(flagsOffset)
        : bytes.readUInt32BE(flagsOffset),
    };
    return architecture === "mips"
      ? ok({
          format: "elf",
          architecture,
          availableArchitectures: [architecture],
          mips: metadata,
        })
      : ok({
          format: "elf",
          architecture,
          availableArchitectures: [architecture],
          riscv: metadata,
        });
  }
  return ok({
    format: "elf",
    architecture,
    availableArchitectures: [architecture],
  });
};

const parseMz = (
  bytes: Buffer,
  fileSize: number,
  signatureAtOffset?: Buffer,
): Result<ExecutableMetadata, string> => {
  const windowsHeader = observeMzWindowsHeader(
    bytes,
    fileSize,
    signatureAtOffset,
  );
  if (
    windowsHeader.state === "header-needed" ||
    windowsHeader.state === "signature-needed"
  )
    return err(
      "Windows new-header pointer or signature is outside the bounded prefix",
    );
  if (windowsHeader.state === "declared") {
    const { offset } = windowsHeader;
    if (offset < 64 || offset > bytes.length - 24)
      return err("invalid or truncated Windows executable header in MZ image");
    if (["NE", "LE", "LX"].includes(windowsHeader.signature))
      return err(
        `unsupported ${windowsHeader.signature} executable in MZ image`,
      );
    if (windowsHeader.signature !== "PE")
      return err("invalid or truncated Windows executable header in MZ image");
    return parsePeRecord(bytes.subarray(offset));
  }
  const parsed = parseDosMzHeader(bytes, fileSize, signatureAtOffset);
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
  const machineType = record.readUInt16LE(4);
  const machine = decodePeMachine(machineType);
  if (machine === undefined)
    return err(
      `unsupported PE architecture (COFF machine 0x${machineType.toString(16).padStart(4, "0")})`,
    );
  const { architecture } = machine;
  const optionalHeaderSize = record.readUInt16LE(20);
  if (optionalHeaderSize > 4096 || record.length < 24 + optionalHeaderSize)
    return err("invalid or truncated PE optional header");
  const optionalHeader = record.subarray(24, 24 + optionalHeaderSize);
  const managed = peManagedStatus(optionalHeader, architecture);
  if (!managed.ok) return managed;
  if (machine.nativeOsOverride && !managed.value)
    return err("unsupported PE architecture");
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

const machArchitecture = (cpu: number): HeaderArchitecture | undefined => {
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

const elfArchitecture = (
  machine: number,
): Exclude<BinaryArchitecture, "6502"> | undefined => {
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
    case 243: // EM_RISCV: XLEN, byte order and e_flags remain separate ELF facts.
      return "riscv";
  }
  return undefined;
};
