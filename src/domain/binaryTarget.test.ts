import { describe, expect, it } from "vitest";

import { parseExecutableHeader } from "./binaryTarget.js";
import { elf, fat, pe, thinMach } from "./binaryTarget.fixture.js";

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
