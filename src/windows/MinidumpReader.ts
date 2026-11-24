/**
 * Windows Minidump (.dmp / MDMP) format parser for crash forensics and register analysis.
 */

import { BinaryReader } from "../domain/binaryContainer.js";

export interface MinidumpException {
  readonly threadId: number;
  readonly code: number;
  readonly codeHex: string;
  readonly codeName: string;
  readonly address: bigint;
  readonly flags: number;
}

export interface MinidumpModule {
  readonly name: string | null;
  readonly baseAddress: bigint;
  readonly size: number;
  readonly timestamp: Date;
}

export interface MinidumpSystemInfo {
  readonly architecture: string;
  readonly numberOfProcessors: number;
  readonly majorVersion: number;
  readonly minorVersion: number;
  readonly buildNumber: number;
  readonly csdVersion?: string | undefined;
}

export interface MinidumpReport {
  readonly timestamp: Date;
  readonly systemInfo?: MinidumpSystemInfo | undefined;
  readonly exception?: MinidumpException | undefined;
  readonly modules: readonly MinidumpModule[];
  readonly streamTypes: readonly number[];
  readonly limitations: readonly string[];
}

const MINIDUMP_SIGNATURE = 0x504d444d; // "MDMP" in LE
const MINIDUMP_VERSION = 0xa793; // Low word of MINIDUMP_HEADER.Version

const ARCH_NAMES: Readonly<Record<number, string>> = {
  0: "x86",
  5: "ARM",
  6: "IA64",
  9: "x86-64 (AMD64)",
  12: "ARM64",
};

const EXCEPTION_NAMES: Readonly<Record<number, string>> = {
  0xc0000005: "STATUS_ACCESS_VIOLATION",
  0x80000003: "STATUS_BREAKPOINT",
  0xc00000fd: "STATUS_STACK_OVERFLOW",
  0xc000001d: "STATUS_ILLEGAL_INSTRUCTION",
  0xc0000025: "STATUS_NONCONTINUABLE_EXCEPTION",
  0xc0000094: "STATUS_INTEGER_DIVIDE_BY_ZERO",
  0xc0000096: "STATUS_PRIVILEGED_INSTRUCTION",
  0xe06d7363: "CPP_EXCEPTION",
};

export const isMinidump = (buffer: Buffer): boolean => {
  if (buffer.length < 32) return false;
  const reader = new BinaryReader(buffer, true, "minidump");
  return (
    reader.u32(0) === MINIDUMP_SIGNATURE && reader.u16(4) === MINIDUMP_VERSION
  );
};

export const MAX_MINIDUMP_STRING_BYTES = 64 * 1024; // 64 KiB per string
const MAX_TOTAL_MODULE_NAME_BYTES = 1024 * 1024; // 1 MiB total for all module names
export const MAX_MINIDUMP_STREAMS = 1_024; // Stream directory cap

const readMinidumpString = (
  reader: BinaryReader,
  rva: number,
):
  | { readonly state: "ok"; readonly value: string }
  | { readonly state: "limit" | "malformed" } => {
  if (rva < 0 || rva + 4 > reader.bytes.length) return { state: "malformed" };
  const declaredLen = reader.u32(rva);
  if (declaredLen % 2 !== 0 || declaredLen > reader.bytes.length - (rva + 4)) {
    return { state: "malformed" };
  }
  if (declaredLen > MAX_MINIDUMP_STRING_BYTES) return { state: "limit" };
  return {
    state: "ok",
    value: reader.bytes.toString("utf16le", rva + 4, rva + 4 + declaredLen),
  };
};

const parseSystemInfoStream = (
  reader: BinaryReader,
  rva: number,
  size: number,
): {
  readonly systemInfo?: MinidumpSystemInfo | undefined;
  readonly limitations: readonly string[];
} => {
  if (rva + size > reader.bytes.length || size < 24) {
    return { limitations: [] };
  }
  const archCode = reader.u16(rva);
  const numberOfProcessors = reader.u8(rva + 6);
  const majorVersion = reader.u32(rva + 8);
  const minorVersion = reader.u32(rva + 12);
  const buildNumber = reader.u32(rva + 16);
  const csdRva = size >= 28 ? reader.u32(rva + 24) : 0;
  const parsedCsd = csdRva > 0 ? readMinidumpString(reader, csdRva) : undefined;
  const limitations: string[] = [];
  if (parsedCsd !== undefined && parsedCsd.state !== "ok") {
    limitations.push(
      `SystemInfoStream CSDVersion string had an oversized, out-of-bounds, or malformed UTF-16 byte length and was omitted.`,
    );
  }
  const csdVersion =
    parsedCsd?.state === "ok" && parsedCsd.value.length > 0
      ? parsedCsd.value
      : undefined;

  return {
    systemInfo: {
      architecture: ARCH_NAMES[archCode] ?? `Arch-0x${archCode.toString(16)}`,
      numberOfProcessors,
      majorVersion,
      minorVersion,
      buildNumber,
      csdVersion,
    },
    limitations,
  };
};

const parseExceptionStream = (
  reader: BinaryReader,
  rva: number,
  size: number,
): MinidumpException | undefined => {
  if (rva + size > reader.bytes.length || size < 32) return undefined;
  const threadId = reader.u32(rva);
  const recOffset = rva + 8; // skip threadId + alignment
  const code = reader.u32(recOffset);
  const flags = reader.u32(recOffset + 4);
  const address = reader.word(recOffset + 16, 64);

  const codeHex = `0x${(code >>> 0).toString(16).toUpperCase().padStart(8, "0")}`;
  const codeName = EXCEPTION_NAMES[code] ?? codeHex;

  return {
    threadId,
    code,
    codeHex,
    codeName,
    address,
    flags,
  };
};

const parseModuleListStream = (
  reader: BinaryReader,
  rva: number,
  size: number,
): { readonly modules: MinidumpModule[]; readonly limitations: string[] } => {
  if (rva + size > reader.bytes.length || size < 4) {
    return {
      modules: [],
      limitations: [
        "ModuleListStream is truncated or extends past the end of the minidump.",
      ],
    };
  }
  const count = reader.u32(rva);
  const modules: MinidumpModule[] = [];
  const limitations: string[] = [];
  const entrySize = 108; // MINIDUMP_MODULE size
  const maxPossibleEntries = Math.floor((size - 4) / entrySize);
  const safeCount = Math.min(count, maxPossibleEntries, 10_000);
  if (count > safeCount) {
    limitations.push(
      `ModuleListStream declared ${count} modules; only ${safeCount} entries were inspected.`,
    );
  }
  const nameCache = new Map<number, string | null>();
  let totalNameBytes = 0;
  let omittedNames = 0;
  let truncatedOrMalformedNames = 0;

  for (let i = 0; i < safeCount; i += 1) {
    const offset = rva + 4 + i * entrySize;
    if (
      offset + entrySize > rva + size ||
      offset + entrySize > reader.bytes.length
    )
      break;

    const baseAddress = reader.word(offset, 64);
    const modSize = reader.u32(offset + 8);
    const timeDateStamp = reader.u32(offset + 16);
    const nameRva = reader.u32(offset + 20);

    let name: string | null;
    if (nameCache.has(nameRva)) {
      name = nameCache.get(nameRva) ?? null;
    } else if (totalNameBytes < MAX_TOTAL_MODULE_NAME_BYTES) {
      const parsedName = readMinidumpString(reader, nameRva);
      if (parsedName.state === "ok") {
        totalNameBytes += parsedName.value.length * 2;
        nameCache.set(nameRva, parsedName.value);
        name = parsedName.value;
      } else {
        nameCache.set(nameRva, null);
        name = null;
        truncatedOrMalformedNames += 1;
      }
    } else {
      name = null;
      omittedNames += 1;
    }

    modules.push({
      name,
      baseAddress,
      size: modSize,
      timestamp: new Date(timeDateStamp * 1000),
    });
  }

  if (truncatedOrMalformedNames > 0) {
    limitations.push(
      `ModuleListStream contained ${truncatedOrMalformedNames} module name(s) that exceeded the ${MAX_MINIDUMP_STRING_BYTES}-byte string cap, had odd UTF-16 byte lengths, or had out-of-bounds extents; those names were omitted.`,
    );
  }
  if (omittedNames > 0) {
    limitations.push(
      `Module name budget (${MAX_TOTAL_MODULE_NAME_BYTES} bytes) exceeded; ${omittedNames} module name(s) were omitted.`,
    );
  }

  return { modules, limitations };
};

/** Parse Windows Minidump file for crash diagnosis and loaded module analysis. */
export const parseMinidump = (buffer: Buffer): MinidumpReport | null => {
  if (!isMinidump(buffer)) return null;
  const reader = new BinaryReader(buffer, true, "minidump");

  const numberOfStreams = reader.u32(8);
  const streamDirectoryRva = reader.u32(12);
  const timeDateStampSec = reader.u32(20);

  if (streamDirectoryRva + numberOfStreams * 12 > buffer.length) {
    return null;
  }

  const streamTypes: number[] = [];
  let systemInfo: MinidumpSystemInfo | undefined;
  let exception: MinidumpException | undefined;
  let modules: MinidumpModule[] = [];
  const limitations: string[] = [];
  let hasParsedModules = false;

  const inspectedStreams = Math.min(numberOfStreams, MAX_MINIDUMP_STREAMS);
  if (numberOfStreams > inspectedStreams) {
    limitations.push(
      `Minidump header declared ${numberOfStreams} streams; only ${inspectedStreams} stream directory entries were inspected.`,
    );
  }

  for (let i = 0; i < inspectedStreams; i += 1) {
    const entryOffset = streamDirectoryRva + i * 12;
    const streamType = reader.u32(entryOffset);
    const dataSize = reader.u32(entryOffset + 4);
    const rva = reader.u32(entryOffset + 8);

    streamTypes.push(streamType);

    if (streamType === 7 && systemInfo === undefined) {
      // SystemInfoStream
      const parsedSysInfo = parseSystemInfoStream(reader, rva, dataSize);
      systemInfo = parsedSysInfo.systemInfo;
      limitations.push(...parsedSysInfo.limitations);
    } else if (streamType === 6 && exception === undefined) {
      // ExceptionStream
      exception = parseExceptionStream(reader, rva, dataSize);
    } else if (streamType === 4 && !hasParsedModules) {
      // ModuleListStream
      hasParsedModules = true;
      const parsedModules = parseModuleListStream(reader, rva, dataSize);
      modules = parsedModules.modules;
      limitations.push(...parsedModules.limitations);
    }
  }

  return {
    timestamp: new Date(timeDateStampSec * 1000),
    systemInfo,
    exception,
    modules,
    streamTypes,
    limitations,
  };
};
