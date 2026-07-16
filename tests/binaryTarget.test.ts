import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  parseBinaryTarget,
  parseExecutableHeader,
} from "../src/domain/binaryTarget.js";

let directory: string | undefined;
afterEach(async () => {
  if (directory !== undefined)
    await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("executable header parsing", () => {
  it.each([
    [elf(1, 1, 62), "elf", "x86_64"],
    [elf(2, 2, 183), "elf", "arm64"],
    [thinMach(0xfeedfacf, 0x0100000c), "mach-o", "arm64"],
    [thinMach(0xcefaedfe, 0x01000007), "mach-o", "x86_64"],
    [pe(0x8664), "pe", "x86_64"],
    [pe(0xaa64), "pe", "arm64"],
  ] as const)("parses metadata for %s", (bytes, format, architecture) => {
    const result = parseExecutableHeader(bytes, "arm64");
    expect(result.ok && result.value).toMatchObject({ format, architecture });
  });

  it("distinguishes native PE applications, DLLs, and managed assemblies", () => {
    const application = parseExecutableHeader(pe(0x8664), "x64");
    const library = parseExecutableHeader(pe(0x8664, 64, 0x2002), "x64");
    const managed = parseExecutableHeader(pe(0x8664, 64, 0x0002, true), "x64");
    const nonExecutable = parseExecutableHeader(pe(0x8664, 64, 0), "x64");

    expect(application.ok && application.value).toMatchObject({
      executableRole: "application",
      managed: false,
    });
    expect(library.ok && library.value).toMatchObject({
      executableRole: "shared-library",
      managed: false,
    });
    expect(managed.ok && managed.value).toMatchObject({
      executableRole: "application",
      managed: true,
    });
    expect(nonExecutable.ok && nonExecutable.value).toMatchObject({
      executableRole: "non-executable",
      managed: false,
    });
  });

  it("selects the host architecture from a FAT table", () => {
    const bytes = fat([0x01000007, 0x0100000c]);
    const arm = parseExecutableHeader(bytes, "arm64");
    const intel = parseExecutableHeader(bytes, "x64");
    expect(arm.ok && arm.value).toMatchObject({
      architecture: "arm64",
      availableArchitectures: ["x86_64", "arm64"],
    });
    expect(intel.ok && intel.value).toMatchObject({
      architecture: "x86_64",
      availableArchitectures: ["x86_64", "arm64"],
    });
  });

  it("rejects FAT files without a host-compatible slice", () => {
    expect(parseExecutableHeader(fat([0x01000007]), "arm64")).toMatchObject({
      ok: false,
    });
  });

  it.each([
    Buffer.alloc(0),
    Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
    fat([], 2),
    pe(0xffff),
  ])("rejects malformed, truncated, or unsupported metadata", (bytes) => {
    expect(parseExecutableHeader(bytes, "arm64").ok).toBe(false);
  });

  it("rejects malformed PE optional-header commitments", () => {
    const wrongMagic = pe(0x8664);
    wrongMagic.writeUInt16LE(0x10b, 64 + 24);
    const truncatedDirectories = pe(0x8664);
    truncatedDirectories.writeUInt16LE(112, 64 + 20);
    truncatedDirectories.writeUInt32LE(16, 64 + 24 + 108);

    expect(parseExecutableHeader(wrongMagic, "x64").ok).toBe(false);
    expect(parseExecutableHeader(truncatedDirectories, "x64").ok).toBe(false);
  });
});

describe("binary target I/O", () => {
  it("classifies ZIP profiles and text artifacts without Hopper", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rea-artifact-target-"));
    const zip = join(directory, "fixture.apk");
    const script = join(directory, "bundle.js");
    await writeFile(zip, Buffer.from([0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0]));
    await writeFile(script, "export default 1;\n");
    const archive = await parseBinaryTarget(zip);
    const javascript = await parseBinaryTarget(script);
    expect(archive.ok && archive.value).toMatchObject({
      kind: "archive",
      format: "apk",
    });
    expect(javascript.ok && javascript.value).toMatchObject({
      kind: "artifact",
      format: "javascript",
    });
  });

  it("does not trust a ZIP-family extension without ZIP magic", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rea-fake-archive-"));
    const path = join(directory, "fake.zip");
    await writeFile(path, "not a zip");
    const result = await parseBinaryTarget(path);
    expect(result).toMatchObject({
      ok: false,
      error: { _tag: "BinaryTargetError" },
    });
  });

  it("resolves relative Hopper databases and rejects unknown or unreadable paths", async () => {
    directory = await mkdtemp(join(tmpdir(), "rea-target-"));
    await writeFile(join(directory, "sample.hop"), "database");
    await writeFile(join(directory, "text"), "hello");
    const database = await parseBinaryTarget("sample.hop", directory);
    expect(database.ok && database.value.sha256).toBe(
      "3549b0028b75d981cdda2e573e9cb49dedc200185876df299f912b79f69dabd8",
    );
    expect((await parseBinaryTarget("text", directory)).ok).toBe(false);
    expect((await parseBinaryTarget("missing", directory)).ok).toBe(false);
  });

  it("rejects non-regular targets before reading them", async () => {
    directory = await mkdtemp(join(tmpdir(), "rea-target-"));
    expect((await parseBinaryTarget(directory)).ok).toBe(false);
  });

  it("resolves a macOS app bundle to its declared program file", async () => {
    directory = await mkdtemp(join(tmpdir(), "rea-target-"));
    const app = join(directory, "Example App.app");
    const contents = join(app, "Contents");
    const programs = join(contents, "MacOS");
    await mkdir(programs, { recursive: true });
    await writeFile(
      join(contents, "Info.plist"),
      '<?xml version="1.0"?><plist><dict><key>CFBundleExecutable</key><string>Example &amp; Tool</string></dict></plist>',
    );
    await writeFile(
      join(programs, "Example & Tool"),
      thinMach(0xfeedfacf, 0x0100000c),
    );
    const result = await parseBinaryTarget(app, directory, "arm64");
    expect(result.ok && result.value).toMatchObject({
      path: await realpath(join(programs, "Example & Tool")),
      format: "mach-o",
    });
  });

  it.each([
    ["missing plist", undefined],
    ["missing executable name", "<plist><dict></dict></plist>"],
    [
      "unsafe executable name",
      "<plist><dict><key>CFBundleExecutable</key><string>../escape</string></dict></plist>",
    ],
    [
      "missing program file",
      "<plist><dict><key>CFBundleExecutable</key><string>Missing</string></dict></plist>",
    ],
  ])("rejects an app bundle with %s", async (_case, plist) => {
    directory = await mkdtemp(join(tmpdir(), "rea-target-"));
    const app = join(directory, "Broken.app");
    const contents = join(app, "Contents");
    await mkdir(join(contents, "MacOS"), { recursive: true });
    if (plist !== undefined)
      await writeFile(join(contents, "Info.plist"), plist);
    expect((await parseBinaryTarget(app, directory, "arm64")).ok).toBe(false);
  });

  it("rejects an app program symlink that leaves the bundle", async () => {
    directory = await mkdtemp(join(tmpdir(), "rea-target-"));
    const app = join(directory, "Escaping.app");
    const contents = join(app, "Contents");
    const programs = join(contents, "MacOS");
    const outside = join(directory, "outside");
    await mkdir(programs, { recursive: true });
    await writeFile(outside, thinMach(0xfeedfacf, 0x0100000c));
    await writeFile(
      join(contents, "Info.plist"),
      "<plist><dict><key>CFBundleExecutable</key><string>Escaping</string></dict></plist>",
    );
    await symlink(outside, join(programs, "Escaping"));
    expect((await parseBinaryTarget(app, directory, "arm64")).ok).toBe(false);
  });

  it("honors an explicit database kind without relying on the file suffix", async () => {
    directory = await mkdtemp(join(tmpdir(), "rea-target-"));
    await writeFile(join(directory, "saved-analysis"), "database");
    const result = await parseBinaryTarget(
      "saved-analysis",
      directory,
      "arm64",
      "database",
    );
    expect(result.ok && result.value).toMatchObject({
      kind: "database",
      format: "analysis-database",
    });
  });

  it("reads a PE header beyond the initial probe", async () => {
    directory = await mkdtemp(join(tmpdir(), "rea-target-"));
    const path = join(directory, "delayed.exe");
    await writeFile(path, pe(0x8664, 8192));
    const result = await parseBinaryTarget(path, directory, "x64");
    expect(result.ok && result.value).toMatchObject({
      format: "pe",
      architecture: "x86_64",
    });
  });
});

const elf = (class_: number, endian: number, machine: number): Buffer => {
  const bytes = Buffer.alloc(20);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, class_, endian]);
  if (endian === 1) bytes.writeUInt16LE(machine, 18);
  else bytes.writeUInt16BE(machine, 18);
  return bytes;
};
const thinMach = (magic: number, cpu: number): Buffer => {
  const bytes = Buffer.alloc(8);
  bytes.writeUInt32BE(magic, 0);
  if (magic === 0xcefaedfe || magic === 0xcffaedfe) bytes.writeUInt32LE(cpu, 4);
  else bytes.writeUInt32BE(cpu, 4);
  return bytes;
};
const fat = (cpus: readonly number[], declared = cpus.length): Buffer => {
  const bytes = Buffer.alloc(8 + cpus.length * 20);
  bytes.writeUInt32BE(0xcafebabe, 0);
  bytes.writeUInt32BE(declared, 4);
  cpus.forEach((cpu, index) => bytes.writeUInt32BE(cpu, 8 + index * 20));
  return bytes;
};
const pe = (
  machine: number,
  offset = 64,
  characteristics = 0x0002,
  managed = false,
): Buffer => {
  const optionalHeaderSize =
    machine === 0x014c || machine === 0x01c0 ? 224 : 240;
  const bytes = Buffer.alloc(Math.max(512, offset + 24 + optionalHeaderSize));
  bytes.write("MZ", 0, "ascii");
  bytes.writeUInt32LE(offset, 0x3c);
  bytes.write("PE\0\0", offset, "binary");
  bytes.writeUInt16LE(machine, offset + 4);
  bytes.writeUInt16LE(optionalHeaderSize, offset + 20);
  bytes.writeUInt16LE(characteristics, offset + 22);
  const optionalHeader = offset + 24;
  const pe32 = machine === 0x014c || machine === 0x01c0;
  bytes.writeUInt16LE(pe32 ? 0x10b : 0x20b, optionalHeader);
  const directoryOffset = pe32 ? 96 : 112;
  bytes.writeUInt32LE(16, optionalHeader + directoryOffset - 4);
  if (managed) {
    bytes.writeUInt32LE(0x2000, optionalHeader + directoryOffset + 14 * 8);
    bytes.writeUInt32LE(72, optionalHeader + directoryOffset + 14 * 8 + 4);
  }
  return bytes;
};
