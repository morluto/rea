import { dosMz } from "../../../src/domain/binaryTarget.fixture.js";
import { lstat, symlink } from "node:fs/promises";
import { join } from "node:path";

/** Actual filesystem paths that fail before Go artifact acquisition begins. */
export const createGoBinaryPathFailureFixture = async (
  root: string,
  expectedErrno: "ELOOP" | "ENAMETOOLONG",
): Promise<{ path: string; errno: string }> => {
  let path = join(root, "a".repeat(256));
  if (expectedErrno === "ELOOP") {
    const loop = join(root, "loop");
    await symlink(loop, loop, "dir");
    path = join(loop, "application");
  }
  try {
    await lstat(path);
  } catch (cause: unknown) {
    if (
      !(cause instanceof Error) ||
      !("code" in cause) ||
      typeof cause.code !== "string"
    )
      throw cause;
    if (
      (expectedErrno === "ELOOP" || process.platform === "linux") &&
      cause.code !== expectedErrno
    )
      throw new Error(
        `Path fixture expected ${expectedErrno}, but native lstat returned ${cause.code}.`,
        { cause },
      );
    return { path, errno: cause.code };
  }
  throw new Error(`Expected native lstat to reject path fixture: ${path}`);
};

/** Producer-shaped Go metadata used for portable binary format regressions. */
export const GO_MODULE_TEXT =
  "path\texample.com/tool/cmd/tool\n" +
  "mod\texample.com/tool\t(devel)\t\n" +
  "dep\texample.com/dependency\tv1.2.3\th1:sample\n" +
  "=>\t../dependency\t\t\n" +
  "build\t-compiler=gc\n" +
  "build\tGOOS=linux\n" +
  'build\t-ldflags="-s -w"\n';

const MODULE_START = Buffer.from("3077af0c9274080241e1c107e6d618e6", "hex");
const MODULE_END = Buffer.from("f932433186182072008242104116d8f2", "hex");

/** Build an authored, file-backed ELF/PE/Mach-O image without executing code. */
export const createGoBinaryFixture = (
  options: {
    format?: "elf" | "pe" | "macho";
    bits?: 32 | 64;
    byteOrder?: "little" | "big";
    encoding?: "inline" | "pointer";
    sectionless?: boolean;
    goVersion?: string;
    moduleText?: string;
    omitBuildInfo?: boolean;
  } = {},
): {
  bytes: Buffer;
  headerOffset: number;
  versionOffset: number;
  moduleOffset: number;
  moduleBytes: Buffer;
} => {
  const format = options.format ?? "elf";
  const bits = options.bits ?? 64;
  const little = (options.byteOrder ?? "little") === "little";
  const encoding = options.encoding ?? "inline";
  const bytes = Buffer.alloc(4096);
  const headerOffset = 1024;
  const base = 0x10000;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (offset: number, value: number) =>
    view.setUint16(offset, value, little);
  const u32 = (offset: number, value: number) =>
    view.setUint32(offset, value, little);
  const word = (offset: number, value: number) => {
    if (bits === 64) view.setBigUint64(offset, BigInt(value), little);
    else u32(offset, value);
  };
  writeFixtureContainer(format, options.sectionless ?? false, {
    bytes,
    bits,
    little,
    base,
    headerOffset,
    u16,
    u32,
    word,
  });
  const version = Buffer.from(options.goVersion ?? "go1.26.0");
  const moduleBytes = Buffer.concat([
    MODULE_START,
    Buffer.from(options.moduleText ?? GO_MODULE_TEXT),
    MODULE_END,
  ]);
  let versionOffset: number;
  let moduleOffset: number;
  if (encoding === "inline") {
    const versionLength = encodeVarint(version.length);
    versionOffset = headerOffset + 32 + versionLength.length;
    const moduleLength = encodeVarint(moduleBytes.length);
    moduleOffset = versionOffset + version.length + moduleLength.length;
    versionLength.copy(bytes, headerOffset + 32);
    version.copy(bytes, versionOffset);
    moduleLength.copy(bytes, versionOffset + version.length);
    moduleBytes.copy(bytes, moduleOffset);
  } else {
    const width = bits / 8;
    word(headerOffset + 16, base + 1536);
    word(headerOffset + 16 + width, base + 1536 + width * 2);
    versionOffset = 2048;
    moduleOffset = 2304;
    word(1536, base + versionOffset);
    word(1536 + width, version.length);
    word(1536 + width * 2, base + moduleOffset);
    word(1536 + width * 3, moduleBytes.length);
    version.copy(bytes, versionOffset);
    moduleBytes.copy(bytes, moduleOffset);
  }
  if (!options.omitBuildInfo) {
    Buffer.from("ff20476f206275696c64696e663a", "hex").copy(
      bytes,
      headerOffset,
    );
    bytes[headerOffset + 14] = bits / 8;
    bytes[headerOffset + 15] =
      (little ? 0 : 1) | (encoding === "inline" ? 2 : 0);
  }
  return { bytes, headerOffset, versionOffset, moduleOffset, moduleBytes };
};

/** Embedded invalid UTF-8 alongside valid records, with exact independent byte expectations. */
export const createGoBinaryByteStringFixture = () => {
  const version = Buffer.from("xgo1.26.0");
  const invalidLine = Buffer.from("build\t-tags=x");
  const fixture = createGoBinaryFixture({
    goVersion: version.toString("utf8"),
    moduleText:
      "path\texample.com/tool/cmd/tool\n" +
      "mod\texample.com/tool\t(devel)\t\n" +
      "build\tGOARCH=amd64\n" +
      `${invalidLine.toString("utf8")}\n`,
  });
  version[0] = 0xff;
  version.copy(fixture.bytes, fixture.versionOffset);
  const lineOffset = fixture.moduleBytes.indexOf(invalidLine);
  fixture.moduleBytes[lineOffset + invalidLine.length - 1] = 0xff;
  invalidLine[invalidLine.length - 1] = 0xff;
  fixture.moduleBytes.copy(fixture.bytes, fixture.moduleOffset);
  return {
    bytes: fixture.bytes,
    expectedBuildInfo: {
      header_offset: fixture.headerOffset,
      encoding: "inline",
      go_version: null,
      go_version_bytes_base64: version.toString("base64"),
      module_text: null,
      module_bytes_base64: fixture.moduleBytes.toString("base64"),
      version_location: {
        offset: fixture.versionOffset,
        bytes: version.length,
      },
      module_location: {
        offset: fixture.moduleOffset,
        bytes: fixture.moduleBytes.length,
      },
      module: {
        path: "example.com/tool/cmd/tool",
        main: {
          path: "example.com/tool",
          version: "(devel)",
          sum: "",
          replacement: null,
        },
        dependencies: [],
        settings: [{ key: "GOARCH", value: "amd64" }],
        unparsed_lines: [],
        unparsed_line_bytes_base64: [invalidLine.toString("base64")],
        complete: false,
      },
    },
  };
};

/** Unsupported DOS/Windows carriers and damaged PE records for public diagnostics. */
export const createGoBinaryDiagnosticFixtures = () => {
  const unsupported = [
    { name: "dos-short", bytes: dosMz(16) },
    { name: "dos", bytes: dosMz() },
  ];
  for (const signature of ["NE", "LE", "LX"]) {
    const bytes = dosMz();
    bytes.writeUInt16LE(4, 8);
    bytes.writeUInt32LE(64, 60);
    bytes.write(signature, 64, "ascii");
    unsupported.push({ name: signature.toLowerCase(), bytes });
  }
  const damagedPe = createGoBinaryFixture({ format: "pe" }).bytes;
  damagedPe.write("NO", 128, "ascii");
  const absentDirectories = createGoBinaryFixture({ format: "pe" }).bytes;
  absentDirectories.writeUInt32LE(1, 152 + 108);
  const shortOptionalHeaders = [0, 1].map((size) => {
    const bytes = createGoBinaryFixture({ format: "pe" }).bytes;
    bytes.writeUInt16LE(size, 148);
    // Bytes following the declared header must not supply its magic field.
    bytes.fill(0xff, 152 + size, 154);
    return { name: `optional-header-${String(size)}-bytes`, bytes };
  });
  return [
    ...unsupported.map((fixture) => ({
      ...fixture,
      code: "unsupported_target" as const,
      details: { operation: "inspect_go_binary" },
    })),
    ...[
      { name: "damaged-pe", bytes: damagedPe },
      { name: "absent-directories", bytes: absentDirectories },
      ...shortOptionalHeaders,
    ].map((fixture) => ({
      ...fixture,
      code: "invalid_request" as const,
      details: {
        operation: "inspect_go_binary",
        issues: [{ path: ["path"], reason: "invalid_format" }],
      },
    })),
  ];
};

const encodeVarint = (input: number): Buffer => {
  let value = BigInt(input);
  const bytes: number[] = [];
  while (value >= 128n) {
    bytes.push(Number(value & 127n) | 128);
    value >>= 7n;
  }
  bytes.push(Number(value));
  return Buffer.from(bytes);
};

const writeFixtureContainer = (
  format: "elf" | "pe" | "macho",
  sectionless: boolean,
  context: {
    bytes: Buffer;
    bits: 32 | 64;
    little: boolean;
    base: number;
    headerOffset: number;
    u16: (offset: number, value: number) => void;
    u32: (offset: number, value: number) => void;
    word: (offset: number, value: number) => void;
  },
): void => {
  const { bytes, bits, little, base, headerOffset, u16, u32, word } = context;
  if (format === "elf") {
    bytes.set([0x7f, 0x45, 0x4c, 0x46, bits === 64 ? 2 : 1, little ? 1 : 2, 1]);
    u16(16, 2);
    u16(18, bits === 64 ? 62 : 3);
    u32(20, 1);
    const wide = bits === 64;
    word(wide ? 32 : 28, 128);
    word(wide ? 40 : 32, sectionless ? 0 : 256);
    u16(wide ? 52 : 40, wide ? 64 : 52);
    u16(wide ? 54 : 42, wide ? 56 : 32);
    u16(wide ? 56 : 44, 1);
    u16(wide ? 58 : 46, wide ? 64 : 40);
    u16(wide ? 60 : 48, sectionless ? 0 : 3);
    u16(wide ? 62 : 50, sectionless ? 0 : 1);
    u32(128, 1);
    if (wide) {
      u32(132, 6);
      word(136, 0);
      word(144, base);
      word(160, bytes.length);
      word(168, bytes.length);
    } else {
      word(132, 0);
      word(136, base);
      word(144, bytes.length);
      word(148, bytes.length);
      u32(152, 6);
    }
    if (!sectionless) {
      const entrySize = wide ? 64 : 40;
      const strings = Buffer.from("\0.shstrtab\0.go.buildinfo\0");
      strings.copy(bytes, 768);
      const names = 256 + entrySize;
      u32(names, 1);
      u32(names + 4, 3);
      word(names + (wide ? 24 : 16), 768);
      word(names + (wide ? 32 : 20), strings.length);
      const info = 256 + entrySize * 2;
      u32(info, 11);
      u32(info + 4, 1);
      word(info + (wide ? 16 : 12), base + headerOffset);
      word(info + (wide ? 24 : 16), headerOffset);
      word(info + (wide ? 32 : 20), 2048);
    }
  } else if (format === "pe") {
    if (!little) throw new Error("PE fixtures are little endian");
    bytes.write("MZ", 0, "ascii");
    u32(60, 128);
    bytes.write("PE\0\0", 128, "ascii");
    u16(132, bits === 64 ? 0x8664 : 0x14c);
    u16(134, 1);
    const optionalSize = bits === 64 ? 112 : 96;
    u16(148, optionalSize);
    u16(152, bits === 64 ? 0x20b : 0x10b);
    word(152 + (bits === 64 ? 24 : 28), base);
    const section = 152 + optionalSize;
    bytes.write(".data", section, "ascii");
    u32(section + 8, 2048);
    u32(section + 12, headerOffset);
    u32(section + 16, 2048);
    u32(section + 20, headerOffset);
    u32(section + 36, 0xc0000040);
  } else {
    const wide = bits === 64;
    u32(0, wide ? 0xfeedfacf : 0xfeedface);
    u32(4, wide ? 0x01000007 : 7);
    u32(8, 3);
    u32(12, 2);
    u32(16, 1);
    const segmentSize = wide ? 72 : 56;
    const sectionSize = wide ? 80 : 68;
    const commandSize = segmentSize + (sectionless ? 0 : sectionSize);
    u32(20, commandSize);
    const command = wide ? 32 : 28;
    u32(command, wide ? 0x19 : 1);
    u32(command + 4, commandSize);
    bytes.write("__DATA", command + 8, "ascii");
    word(command + 24, base);
    word(command + (wide ? 32 : 28), bytes.length);
    word(command + (wide ? 40 : 32), 0);
    word(command + (wide ? 48 : 36), bytes.length);
    u32(command + (wide ? 56 : 40), 3);
    u32(command + (wide ? 60 : 44), 3);
    u32(command + (wide ? 64 : 48), sectionless ? 0 : 1);
    if (!sectionless) {
      const section = command + segmentSize;
      bytes.write("__go_buildinfo", section, "ascii");
      bytes.write("__DATA", section + 16, "ascii");
      word(section + 32, base + headerOffset);
      word(section + (wide ? 40 : 36), 2048);
      u32(section + (wide ? 48 : 40), headerOffset);
    }
  }
};
