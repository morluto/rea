import { constants } from "node:fs";
import { access, open, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { BinaryTargetError } from "./errors.js";
import { err, ok, type Result } from "./result.js";

/** CPU families understood by the supported executable loaders. */
export type BinaryArchitecture = "x86" | "x86_64" | "arm" | "arm64";
/**
 * A canonical local target plus deterministic Hopper loader arguments.
 * Explicit loader and architecture flags prevent Hopper from presenting modal
 * format or FAT-architecture selection dialogs during agent-driven analysis.
 */
export interface BinaryTarget {
  readonly path: string;
  readonly kind: "executable" | "database";
  readonly format: "hopper" | "mach-o" | "elf" | "pe";
  readonly architecture?: BinaryArchitecture;
  readonly availableArchitectures?: readonly BinaryArchitecture[];
  readonly loaderArgs: readonly string[];
}

/**
 * Resolve and classify a readable local target before Hopper is launched.
 * FAT Mach-O inputs select only a host-compatible architecture so setup remains
 * non-interactive; unsupported or ambiguous inputs are returned as typed errors.
 */
export const parseBinaryTarget = async (
  input: string,
  cwd = process.cwd(),
  hostArchitecture: NodeJS.Architecture = process.arch,
): Promise<Result<BinaryTarget, BinaryTargetError>> => {
  const candidate = isAbsolute(input) ? input : resolve(cwd, input);
  try {
    await access(candidate, constants.R_OK);
    const path = await realpath(candidate);
    if (path.toLowerCase().endsWith(".hop"))
      return ok({ path, kind: "database", format: "hopper", loaderArgs: [] });
    const handle = await open(path, "r");
    let bytes: Buffer;
    try {
      bytes = Buffer.alloc(4096);
      const read = await handle.read(bytes, 0, bytes.length, 0);
      bytes = bytes.subarray(0, read.bytesRead);
    } finally {
      await handle.close();
    }
    const detected = parseExecutableHeader(bytes, hostArchitecture);
    if (!detected.ok) return err(new BinaryTargetError(path, detected.error));
    return ok({ path, kind: "executable", ...detected.value });
  } catch (cause: unknown) {
    return err(
      new BinaryTargetError(candidate, "path is not readable", { cause }),
    );
  }
};

type ExecutableMetadata = Pick<
  BinaryTarget,
  "format" | "architecture" | "availableArchitectures" | "loaderArgs"
>;

/**
 * Parse supported executable headers without I/O and derive explicit Hopper
 * loader arguments. The caller must supply the host architecture used for FAT
 * Mach-O slice selection.
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
    loaderArgs: ["-l", "Mach-O", hopperArchitectureFlag(architecture)],
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
    loaderArgs: [
      "-l",
      "FAT",
      hopperArchitectureFlag(preferred),
      "-l",
      "Mach-O",
    ],
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
    loaderArgs: ["-l", "ELF", hopperArchitectureFlag(architecture)],
  });
};

const parsePe = (bytes: Buffer): Result<ExecutableMetadata, string> => {
  if (bytes.length < 64) return err("truncated PE DOS header");
  const offset = bytes.readUInt32LE(0x3c);
  if (
    offset > bytes.length - 6 ||
    bytes.toString("binary", offset, offset + 4) !== "PE\u0000\u0000"
  )
    return err("invalid or truncated PE header");
  const architecture = peArchitecture(bytes.readUInt16LE(offset + 4));
  if (architecture === undefined) return err("unsupported PE architecture");
  return ok({
    format: "pe",
    architecture,
    availableArchitectures: [architecture],
    loaderArgs: ["-l", "WinPE", hopperArchitectureFlag(architecture)],
  });
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

const hopperArchitectureFlag = (architecture: BinaryArchitecture): string => {
  switch (architecture) {
    case "x86":
      return "--intel-32";
    case "x86_64":
      return "--intel-64";
    case "arm":
      return "--armv7";
    case "arm64":
      return "--aarch64";
  }
};
