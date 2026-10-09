import type {
  MachoDependency,
  MachoImageFacts,
  MachoSlice,
} from "../../domain/apple/dylibResolution.js";
import {
  readFatSliceDeclarations,
  validateFatSlice,
  type FatSliceDeclaration,
} from "../../domain/apple/machoContainer.js";

/** Read `length` bytes at `offset`; shorter results mean end of file. */
export type ReadAt = (offset: number, length: number) => Promise<Uint8Array>;

/** Load commands larger than this are refused instead of buffered. */
export const MAX_LOAD_COMMAND_BYTES = 16 * 1024 * 1024;
/** Target opening accepts up to 128 FAT records; Java class files share the FAT magic. */
const MAX_FAT_ARCHITECTURES = 128;
/** CPU types of real Mach-O slices (x86, x86_64, arm, arm64, arm64_32, ppc, ppc64). */
const KNOWN_CPU_TYPES: readonly number[] = [
  7, 0x01000007, 12, 0x0100000c, 0x0200000c, 18, 0x01000012,
];

const MH_MAGIC = 0xfeedface;
const MH_MAGIC_64 = 0xfeedfacf;
const MH_CIGAM = 0xcefaedfe;
const MH_CIGAM_64 = 0xcffaedfe;
const FAT_MAGIC = 0xcafebabe;
const FAT_MAGIC_64 = 0xcafebabf;
const FAT_CIGAM = 0xbebafeca;
const FAT_CIGAM_64 = 0xbfbafeca;

const LC_ID_DYLIB = 0xd;
const LC_LOAD_DYLIB = 0xc;
const LC_LOAD_WEAK_DYLIB = 0x80000018;
const LC_REEXPORT_DYLIB = 0x8000001f;
const LC_LAZY_LOAD_DYLIB = 0x20;
const LC_LOAD_UPWARD_DYLIB = 0x80000023;
const LC_RPATH = 0x8000001c;
const LC_DYLD_ENVIRONMENT = 0x27;
const LC_CODE_SIGNATURE = 0x1d;
const LC_VERSION_MIN_MACOSX = 0x24;
const LC_VERSION_MIN_IPHONEOS = 0x25;
const LC_VERSION_MIN_TVOS = 0x2f;
const LC_VERSION_MIN_WATCHOS = 0x30;
const LC_BUILD_VERSION = 0x32;

/** `mach-o/loader.h` `dylib_use_command`: `nameoff == 28` and this marker. */
const DYLIB_USE_MARKER = 0x1a741800;
const DYLIB_USE_WEAK_LINK = 0x1;
const DYLIB_USE_REEXPORT = 0x2;
const DYLIB_USE_UPWARD = 0x4;
const DYLIB_USE_DELAYED_INIT = 0x8;

const DEPENDENCY_COMMANDS: ReadonlyMap<number, MachoDependency["command"]> =
  new Map([
    [LC_LOAD_DYLIB, "LC_LOAD_DYLIB"],
    [LC_LOAD_WEAK_DYLIB, "LC_LOAD_WEAK_DYLIB"],
    [LC_REEXPORT_DYLIB, "LC_REEXPORT_DYLIB"],
    [LC_LAZY_LOAD_DYLIB, "LC_LAZY_LOAD_DYLIB"],
    [LC_LOAD_UPWARD_DYLIB, "LC_LOAD_UPWARD_DYLIB"],
  ]);

/** Malformed or unsupported structure found while decoding one image. */
class MachoFormatIssue extends Error {
  constructor(
    readonly status: "malformed" | "unsupported",
    message: string,
  ) {
    super(message);
  }
}

/** Report whether the first bytes carry a Mach-O or FAT magic number. */
export const hasMachoMagic = (head: Uint8Array): boolean => {
  if (head.byteLength < 4) return false;
  const magic = new DataView(
    head.buffer,
    head.byteOffset,
    head.byteLength,
  ).getUint32(0, false);
  return [
    MH_MAGIC,
    MH_MAGIC_64,
    MH_CIGAM,
    MH_CIGAM_64,
    FAT_MAGIC,
    FAT_MAGIC_64,
    FAT_CIGAM,
    FAT_CIGAM_64,
  ].includes(magic);
};

/** Decode every slice's dylib-loading load commands without reading code. */
export const readMachoImage = async (
  readAt: ReadAt,
  size: number,
): Promise<MachoImageFacts> => {
  try {
    const head = await readAt(0, Math.min(size, 8));
    if (head.byteLength < 8)
      // A recognized magic with no room for a header is a truncated image.
      return hasMachoMagic(head)
        ? { status: "malformed", reason: "Mach-O header is truncated" }
        : { status: "not-mach-o" };
    const view = viewOf(head);
    const magic = view.getUint32(0, false);
    if ([FAT_MAGIC, FAT_MAGIC_64, FAT_CIGAM, FAT_CIGAM_64].includes(magic)) {
      // FAT headers are big-endian; the swapped magics store them little-endian.
      const littleEndian = magic === FAT_CIGAM || magic === FAT_CIGAM_64;
      const count = view.getUint32(4, littleEndian);
      const wide = magic === FAT_MAGIC_64 || magic === FAT_CIGAM_64;
      // A Java class file's nonzero major version reads as the count, so an
      // empty architecture table can only be a malformed universal header.
      if (count === 0)
        return {
          status: "malformed",
          reason: "FAT header declares no architectures",
        };
      if (count > MAX_FAT_ARCHITECTURES || 8 + count * (wide ? 32 : 20) > size)
        return { status: "not-mach-o" };
      const tableBytes = await readExact(
        readAt,
        8,
        count * (wide ? 32 : 20),
        "FAT table",
      );
      const declarations = readFatSliceDeclarations(tableBytes, {
        count,
        wide,
        littleEndian,
      });
      if (declarations.status !== "parsed")
        throw new MachoFormatIssue("malformed", declarations.reason);
      // A Java class file's version fields read as a FAT count; its "table" names no CPU.
      if (
        !declarations.slices.some(({ cpuType }) =>
          KNOWN_CPU_TYPES.includes(cpuType),
        )
      ) {
        let hasMachOSliceHeader = false;
        for (const declaration of declarations.slices) {
          if (
            validateFatSlice(
              declaration,
              size,
              8 + count * (wide ? 32 : 20),
            ) !== null
          )
            continue;
          const bytes = await readAt(declaration.offset, 4);
          if (bytes.byteLength < 4) continue;
          const sliceMagic = viewOf(bytes).getUint32(0, false);
          if (
            [MH_MAGIC, MH_MAGIC_64, MH_CIGAM, MH_CIGAM_64].includes(sliceMagic)
          ) {
            hasMachOSliceHeader = true;
            break;
          }
        }
        if (!hasMachOSliceHeader) return { status: "not-mach-o" };
      }
      return {
        status: "parsed",
        slices: await readFatSlices(
          readAt,
          size,
          8 + count * (wide ? 32 : 20),
          declarations.slices,
        ),
      };
    }
    if (magic === MH_CIGAM || magic === MH_CIGAM_64)
      return { status: "parsed", slices: [await readSlice(readAt, 0, size)] };
    if (magic === MH_MAGIC || magic === MH_MAGIC_64)
      throw new MachoFormatIssue(
        "unsupported",
        "big-endian Mach-O images are not supported",
      );
    return { status: "not-mach-o" };
  } catch (cause: unknown) {
    if (cause instanceof MachoFormatIssue)
      return { status: cause.status, reason: cause.message };
    throw cause;
  }
};

const readFatSlices = async (
  readAt: ReadAt,
  size: number,
  tableEnd: number,
  declarations: readonly FatSliceDeclaration[],
): Promise<MachoSlice[]> => {
  const slices: MachoSlice[] = [];
  for (const declaration of declarations) {
    const { index, offset, size: length, cpuType, cpuSubtype } = declaration;
    const rangeIssue = validateFatSlice(declaration, size, tableEnd);
    if (rangeIssue !== null)
      throw new MachoFormatIssue(
        rangeIssue.includes("unsupported") ? "unsupported" : "malformed",
        rangeIssue,
      );
    const slice = await readSlice(readAt, offset, length, {
      fatCpuType: cpuType,
      fatCpuSubtype: cpuSubtype,
      alignmentExponent: declaration.alignmentExponent,
    });
    const identityIssue = validateFatSlice(declaration, size, tableEnd, {
      cpuType: slice.cpu_type,
      cpuSubtype: slice.cpu_subtype,
    });
    if (identityIssue !== null)
      throw new MachoFormatIssue("malformed", identityIssue);
    slices.push(slice);
  }
  return slices;
};

const readSlice = async (
  readAt: ReadAt,
  base: number,
  length: number,
  fat: {
    readonly fatCpuType: number;
    readonly fatCpuSubtype: number;
    readonly alignmentExponent: number;
  } | null = null,
): Promise<MachoSlice> => {
  const header = viewOf(await readExact(readAt, base, 28, "Mach-O header"));
  const magic = header.getUint32(0, true);
  if (magic === MH_MAGIC_64 || magic === MH_MAGIC) {
    const wide = magic === MH_MAGIC_64;
    const headerSize = wide ? 32 : 28;
    const commandCount = header.getUint32(16, true);
    const commandBytes = header.getUint32(20, true);
    if (commandBytes > MAX_LOAD_COMMAND_BYTES)
      throw new MachoFormatIssue(
        "unsupported",
        `load commands occupy ${commandBytes} bytes, above the ${MAX_LOAD_COMMAND_BYTES}-byte limit`,
      );
    if (headerSize + commandBytes > length)
      throw new MachoFormatIssue(
        "malformed",
        "load commands extend beyond the Mach-O slice",
      );
    const commands = await readExact(
      readAt,
      base + headerSize,
      commandBytes,
      "load commands",
    );
    const slice = decodeCommands(commands, {
      wide,
      cpuType: header.getUint32(4, true),
      cpuSubtype: header.getUint32(8, true),
      fileType: header.getUint32(12, true),
      commandCount,
      sliceOffset: base,
      sliceSize: length,
      fatCpuType: fat?.fatCpuType ?? null,
      fatCpuSubtype: fat?.fatCpuSubtype ?? null,
      fatAlignmentExponent: fat?.alignmentExponent ?? null,
    });
    const distinctPlatforms = [...new Set(slice.platforms)];
    slice.platform =
      distinctPlatforms.length === 1 ? (distinctPlatforms[0] ?? null) : null;
    return slice;
  }
  throw new MachoFormatIssue(
    magic === swap(MH_MAGIC) || magic === swap(MH_MAGIC_64)
      ? "unsupported"
      : "malformed",
    magic === swap(MH_MAGIC) || magic === swap(MH_MAGIC_64)
      ? "big-endian Mach-O slices are not supported"
      : `slice at offset ${base} has no Mach-O header`,
  );
};

const decodeCommands = (
  bytes: Uint8Array,
  header: {
    readonly wide: boolean;
    readonly cpuType: number;
    readonly cpuSubtype: number;
    readonly fileType: number;
    readonly commandCount: number;
    readonly sliceOffset: number;
    readonly sliceSize: number;
    readonly fatCpuType: number | null;
    readonly fatCpuSubtype: number | null;
    readonly fatAlignmentExponent: number | null;
  },
): MachoSlice => {
  // loader.h: load commands are 8-byte aligned in 64-bit images, 4 in 32-bit.
  const alignment = header.wide ? 8 : 4;
  const view = viewOf(bytes);
  const slice: MachoSlice = {
    architecture: architectureName(header.cpuType, header.cpuSubtype),
    slice_offset: header.sliceOffset,
    slice_size: header.sliceSize,
    cpu_type: header.cpuType,
    cpu_subtype: header.cpuSubtype,
    fat_cpu_type: header.fatCpuType,
    fat_cpu_subtype: header.fatCpuSubtype,
    fat_alignment_exponent: header.fatAlignmentExponent,
    file_type: fileTypeName(header.fileType),
    file_type_code: header.fileType,
    platform: null,
    platforms: [],
    install_name: null,
    dependencies: [],
    rpaths: [],
    dyld_environment: [],
    code_signature_present: false,
  };
  let offset = 0;
  for (let index = 0; index < header.commandCount; index++) {
    if (offset + 8 > bytes.byteLength)
      throw new MachoFormatIssue(
        "malformed",
        `load command ${index} starts beyond sizeofcmds`,
      );
    const command = view.getUint32(offset, true);
    const size = view.getUint32(offset + 4, true);
    if (size < 8 || size % alignment !== 0 || offset + size > bytes.byteLength)
      throw new MachoFormatIssue(
        "malformed",
        `load command ${index} at offset ${offset} has invalid cmdsize ${size}`,
      );
    const body = bytes.subarray(offset, offset + size);
    decodeCommand(command, body, index, slice);
    offset += size;
  }
  if (offset !== bytes.byteLength)
    throw new MachoFormatIssue(
      "malformed",
      `load commands declare ${header.commandCount} commands but sizeofcmds holds ${bytes.byteLength} bytes`,
    );
  return slice;
};

const decodeCommand = (
  command: number,
  body: Uint8Array,
  index: number,
  slice: MachoSlice,
): void => {
  if (command === LC_ID_DYLIB) {
    slice.install_name = commandString(body, 24, index);
    return;
  }
  if (command === LC_RPATH) {
    slice.rpaths.push(commandString(body, 12, index));
    return;
  }
  if (command === LC_DYLD_ENVIRONMENT) {
    slice.dyld_environment.push(commandString(body, 12, index));
    return;
  }
  if (command === LC_CODE_SIGNATURE) {
    // linkedit_data_command: cmd, cmdsize, dataoff, datasize.
    if (body.byteLength < 16)
      throw new MachoFormatIssue(
        "malformed",
        `load command ${index} is too short for LC_CODE_SIGNATURE`,
      );
    slice.code_signature_present = true;
    return;
  }
  if (command === LC_BUILD_VERSION) {
    if (body.byteLength < 24)
      throw new MachoFormatIssue(
        "malformed",
        `load command ${index} is too short for LC_BUILD_VERSION`,
      );
    const platform = viewOf(body).getUint32(8, true);
    slice.platforms.push(platform);
    return;
  }
  // Legacy version-min commands predate explicit simulator platform IDs.
  // Match dyld's CPU-based interpretation: tvOS used x86_64, while iOS
  // and watchOS also had i386 simulator images.
  const x86_64 = slice.cpu_type === (CPU_TYPE_X86 | CPU_ARCH_ABI64);
  const x86 = slice.cpu_type === CPU_TYPE_X86 || x86_64;
  const legacyPlatform = new Map<number, number>([
    [LC_VERSION_MIN_MACOSX, 1],
    [LC_VERSION_MIN_IPHONEOS, x86 ? 7 : 2],
    [LC_VERSION_MIN_TVOS, x86_64 ? 8 : 3],
    [LC_VERSION_MIN_WATCHOS, x86 ? 9 : 4],
  ]).get(command);
  if (legacyPlatform !== undefined) {
    if (body.byteLength < 16)
      throw new MachoFormatIssue(
        "malformed",
        `load command ${index} is too short for a version-min command`,
      );
    slice.platforms.push(legacyPlatform);
    return;
  }
  const name = DEPENDENCY_COMMANDS.get(command);
  if (name !== undefined)
    slice.dependencies.push(decodeDependency(name, body, index));
};

const decodeDependency = (
  command: MachoDependency["command"],
  body: Uint8Array,
  index: number,
): MachoDependency => {
  if (body.byteLength < 24)
    throw new MachoFormatIssue(
      "malformed",
      `load command ${index} is too short for a dylib command`,
    );
  const view = viewOf(body);
  const nameOffset = view.getUint32(8, true);
  const usesFlags =
    nameOffset === 28 &&
    body.byteLength >= 28 &&
    view.getUint32(12, true) === DYLIB_USE_MARKER;
  const flags = usesFlags ? view.getUint32(24, true) : 0;
  return {
    command,
    encoding: usesFlags ? "dylib_use_command" : "dylib_command",
    install_name: commandString(body, usesFlags ? 28 : 24, index),
    weak:
      command === "LC_LOAD_WEAK_DYLIB" || (flags & DYLIB_USE_WEAK_LINK) !== 0,
    upward:
      command === "LC_LOAD_UPWARD_DYLIB" || (flags & DYLIB_USE_UPWARD) !== 0,
    reexport:
      command === "LC_REEXPORT_DYLIB" || (flags & DYLIB_USE_REEXPORT) !== 0,
    delayed_init: (flags & DYLIB_USE_DELAYED_INIT) !== 0,
    current_version: version(view.getUint32(16, true)),
    compatibility_version: version(view.getUint32(20, true)),
  };
};

/** NUL-terminated UTF-8 string at a `lc_str` offset inside one command. */
const commandString = (
  body: Uint8Array,
  minimumOffset: number,
  index: number,
): string => {
  if (body.byteLength < 12)
    throw new MachoFormatIssue(
      "malformed",
      `load command ${index} is too short to hold a string offset`,
    );
  const offset = viewOf(body).getUint32(8, true);
  if (offset < minimumOffset || offset >= body.byteLength)
    throw new MachoFormatIssue(
      "malformed",
      `load command ${index} has string offset ${offset} outside the command`,
    );
  const end = body.indexOf(0, offset);
  if (end < 0)
    throw new MachoFormatIssue(
      "malformed",
      `load command ${index} has an unterminated string`,
    );
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      body.subarray(offset, end),
    );
  } catch {
    throw new MachoFormatIssue(
      "malformed",
      `load command ${index} has a string that is not UTF-8`,
    );
  }
};

const readExact = async (
  readAt: ReadAt,
  offset: number,
  length: number,
  label: string,
): Promise<Uint8Array> => {
  const bytes = await readAt(offset, length);
  if (bytes.byteLength < length)
    throw new MachoFormatIssue("malformed", `${label} is truncated`);
  return bytes;
};

const CPU_ARCH_ABI64 = 0x01000000;
const CPU_ARCH_ABI64_32 = 0x02000000;
const CPU_TYPE_X86 = 7;
const CPU_TYPE_ARM = 12;
const CPU_SUBTYPE_MASK = 0xff000000;
const CPU_SUBTYPE_ARM64E = 2;
const CPU_SUBTYPE_X86_64_H = 8;

const architectureName = (cpuType: number, cpuSubtype: number): string => {
  const subtype = cpuSubtype & ~CPU_SUBTYPE_MASK;
  if (cpuType === (CPU_TYPE_ARM | CPU_ARCH_ABI64))
    return subtype === CPU_SUBTYPE_ARM64E ? "arm64e" : "arm64";
  if (cpuType === (CPU_TYPE_ARM | CPU_ARCH_ABI64_32)) return "arm64_32";
  if (cpuType === (CPU_TYPE_X86 | CPU_ARCH_ABI64))
    return subtype === CPU_SUBTYPE_X86_64_H ? "x86_64h" : "x86_64";
  if (cpuType === CPU_TYPE_X86) return "i386";
  if (cpuType === CPU_TYPE_ARM) return "arm";
  return `cpu-${cpuType.toString(16)}`;
};

const fileTypeName = (fileType: number): MachoSlice["file_type"] =>
  fileType === 2
    ? "execute"
    : fileType === 6
      ? "dylib"
      : fileType === 8
        ? "bundle"
        : "other";

const version = (value: number): string =>
  `${value >>> 16}.${(value >>> 8) & 0xff}.${value & 0xff}`;

const swap = (value: number): number =>
  (((value & 0xff) << 24) |
    ((value & 0xff00) << 8) |
    ((value >>> 8) & 0xff00) |
    (value >>> 24)) >>>
  0;

const viewOf = (bytes: Uint8Array): DataView =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
