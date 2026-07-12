import { constants } from "node:fs";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import {
  access,
  open,
  readFile,
  realpath,
  stat,
  type FileHandle,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { BinaryTargetError } from "./errors.js";
import { err, ok, type Result } from "./result.js";

const execFileAsync = promisify(execFile);

/** CPU families understood by the supported executable loaders. */
type BinaryArchitecture = "x86" | "x86_64" | "arm" | "arm64";
/**
 * A canonical local target plus deterministic Hopper loader arguments.
 * Explicit loader and architecture flags prevent Hopper from presenting modal
 * format or FAT-architecture selection dialogs during agent-driven analysis.
 */
export interface BinaryTarget {
  readonly path: string;
  readonly sha256: string;
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
  targetKind?: BinaryTarget["kind"],
): Promise<Result<BinaryTarget, BinaryTargetError>> => {
  const candidate = isAbsolute(input) ? input : resolve(cwd, input);
  try {
    await access(candidate, constants.R_OK);
    const canonical = await realpath(candidate);
    const resolved = await resolveAppBundle(canonical);
    if (!resolved.ok) return err(resolved.error);
    const path = resolved.value;
    if (!(await stat(path)).isFile())
      return err(new BinaryTargetError(path, "target is not a regular file"));
    if (
      targetKind === "database" ||
      (targetKind === undefined && path.toLowerCase().endsWith(".hop"))
    )
      return ok({
        path,
        sha256: await sha256File(path),
        kind: "database",
        format: "hopper",
        loaderArgs: [],
      });
    const handle = await open(path, "r");
    let detected: Result<ExecutableMetadata, string>;
    try {
      detected = await readExecutableMetadata(handle, hostArchitecture);
    } finally {
      await handle.close();
    }
    if (!detected.ok) return err(new BinaryTargetError(path, detected.error));
    return ok({
      path,
      sha256: await sha256File(path),
      kind: "executable",
      ...detected.value,
    });
  } catch (cause: unknown) {
    return err(
      new BinaryTargetError(candidate, "path is not readable", { cause }),
    );
  }
};

const sha256File = async (path: string): Promise<string> => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
};

const resolveAppBundle = async (
  path: string,
): Promise<Result<string, BinaryTargetError>> => {
  const metadata = await stat(path);
  if (!metadata.isDirectory()) return ok(path);
  if (extname(path).toLowerCase() !== ".app")
    return err(new BinaryTargetError(path, "target is not an app or file"));
  const plistPath = join(path, "Contents", "Info.plist");
  let name: string;
  try {
    const plist = await readFile(plistPath);
    name =
      plist.subarray(0, 6).toString("ascii") === "bplist"
        ? await readBinaryPlistExecutable(plistPath)
        : parseXmlPlistExecutable(plist.toString("utf8"));
  } catch (cause: unknown) {
    return err(
      new BinaryTargetError(path, "app has no readable CFBundleExecutable", {
        cause,
      }),
    );
  }
  if (!isSafeExecutableName(name))
    return err(
      new BinaryTargetError(path, "app has an unsafe CFBundleExecutable"),
    );
  const programs = join(path, "Contents", "MacOS");
  const executable = join(programs, name);
  try {
    const [canonicalPrograms, canonicalExecutable] = await Promise.all([
      realpath(programs),
      realpath(executable),
    ]);
    const location = relative(canonicalPrograms, canonicalExecutable);
    if (
      location === ".." ||
      location.startsWith(`..${sep}`) ||
      isAbsolute(location)
    )
      return err(
        new BinaryTargetError(path, "app program file leaves Contents/MacOS"),
      );
    return ok(canonicalExecutable);
  } catch (cause: unknown) {
    return err(
      new BinaryTargetError(path, "app program file is missing", { cause }),
    );
  }
};

const parseXmlPlistExecutable = (plist: string): string => {
  const match =
    /<key>\s*CFBundleExecutable\s*<\/key>\s*<string>([^<]+)<\/string>/u.exec(
      plist,
    );
  if (match?.[1] === undefined)
    throw new Error("CFBundleExecutable is missing");
  return decodeXml(match[1].trim());
};

const readBinaryPlistExecutable = async (plistPath: string): Promise<string> =>
  (
    await execFileAsync("/usr/bin/plutil", [
      "-extract",
      "CFBundleExecutable",
      "raw",
      "-o",
      "-",
      plistPath,
    ])
  ).stdout.trim();

const isSafeExecutableName = (name: string): boolean =>
  name.length > 0 &&
  name !== "." &&
  name !== ".." &&
  !name.includes("\0") &&
  !/[/\\]/u.test(name);

const decodeXml = (value: string): string =>
  value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'");

type ExecutableMetadata = Pick<
  BinaryTarget,
  "format" | "architecture" | "availableArchitectures" | "loaderArgs"
>;

const readExecutableMetadata = async (
  handle: FileHandle,
  hostArchitecture: NodeJS.Architecture,
): Promise<Result<ExecutableMetadata, string>> => {
  const prefix = Buffer.alloc(4096);
  const prefixRead = await handle.read(prefix, 0, prefix.length, 0);
  const bytes = prefix.subarray(0, prefixRead.bytesRead);
  if (bytes.length >= 64 && bytes[0] === 0x4d && bytes[1] === 0x5a) {
    const offset = bytes.readUInt32LE(0x3c);
    if (offset > bytes.length - 6) {
      const record = Buffer.alloc(6);
      const recordRead = await handle.read(record, 0, record.length, offset);
      return recordRead.bytesRead === record.length
        ? parsePeRecord(record)
        : err("invalid or truncated PE header");
    }
  }
  if (bytes.length >= 8) {
    const magic = bytes.readUInt32BE(0);
    if ([0xcafebabf, 0xbfbafeca].includes(magic)) {
      const little = magic === 0xbfbafeca;
      const count = little ? bytes.readUInt32LE(4) : bytes.readUInt32BE(4);
      const required = 8 + count * 32;
      if (count <= 128 && required > bytes.length) {
        const header = Buffer.alloc(required);
        const headerRead = await handle.read(header, 0, header.length, 0);
        return parseExecutableHeader(
          header.subarray(0, headerRead.bytesRead),
          hostArchitecture,
        );
      }
    }
  }
  return parseExecutableHeader(bytes, hostArchitecture);
};

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
  if (offset > bytes.length - 6) return err("invalid or truncated PE header");
  return parsePeRecord(bytes.subarray(offset, offset + 6));
};

const parsePeRecord = (record: Buffer): Result<ExecutableMetadata, string> => {
  if (record.length < 6 || record.toString("binary", 0, 4) !== "PE\u0000\u0000")
    return err("invalid or truncated PE header");
  const architecture = peArchitecture(record.readUInt16LE(4));
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
