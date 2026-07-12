import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

  it("selects the host architecture from a FAT table", () => {
    const bytes = fat([0x01000007, 0x0100000c]);
    const arm = parseExecutableHeader(bytes, "arm64");
    const intel = parseExecutableHeader(bytes, "x64");
    expect(arm.ok && arm.value.loaderArgs).toContain("--aarch64");
    expect(intel.ok && intel.value.loaderArgs).toContain("--intel-64");
  });

  it.each([
    [thinMach(0xfeedfacf, 0x0100000c), ["-l", "Mach-O", "--aarch64"]],
    [thinMach(0xcefaedfe, 0x01000007), ["-l", "Mach-O", "--intel-64"]],
    [elf(2, 2, 183), ["-l", "ELF", "--aarch64"]],
    [pe(0x8664), ["-l", "WinPE", "--intel-64"]],
  ] as const)(
    "emits a complete non-interactive Hopper selection",
    (bytes, args) => {
      const result = parseExecutableHeader(bytes, "arm64");
      expect(result.ok && result.value.loaderArgs).toEqual(args);
    },
  );

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
});

describe("binary target I/O", () => {
  it("resolves relative Hopper databases and rejects unknown or unreadable paths", async () => {
    directory = await mkdtemp(join(tmpdir(), "bb-target-"));
    await writeFile(join(directory, "sample.hop"), "database");
    await writeFile(join(directory, "text"), "hello");
    expect((await parseBinaryTarget("sample.hop", directory)).ok).toBe(true);
    expect((await parseBinaryTarget("text", directory)).ok).toBe(false);
    expect((await parseBinaryTarget("missing", directory)).ok).toBe(false);
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
      format: "hopper",
      loaderArgs: [],
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
const pe = (machine: number): Buffer => {
  const bytes = Buffer.alloc(128);
  bytes.write("MZ", 0, "ascii");
  bytes.writeUInt32LE(64, 0x3c);
  bytes.write("PE\0\0", 64, "binary");
  bytes.writeUInt16LE(machine, 68);
  return bytes;
};
