import { describe, expect, it } from "vitest";

import {
  CPU,
  LC,
  dylibCommand,
  fatImage,
  machoImage,
} from "../artifacts/apple/MachoImage.fixture.js";
import { parseMachoLayout, selectMachoSlice } from "./AppleMachoSelection.js";
import { decodeAppleDispatchMetadata } from "./AppleDispatchMetadata.js";

/** macOS 27 system binaries ship CPU_SUBTYPE_ARM64E_X1 (12) with the PAC ABI bit. */
const ARM64E_X1 = { type: 0x0100000c, subtype: 0x8000000c } as const;
const X86_64H = { type: 0x01000007, subtype: 8 } as const;

describe("native Mach-O slice selection", () => {
  it("preserves high-bit section-name bytes instead of ASCII-folding metadata names", () => {
    const segment = Buffer.alloc(152);
    segment.writeUInt32LE(0x19, 0);
    segment.writeUInt32LE(segment.length, 4);
    segment.writeUInt32LE(1, 64);
    // `0xdf` becomes `_` under Buffer's ASCII decoder, falsely producing
    // the known `__objc_classlist` name from a malformed high-bit byte.
    Buffer.from("__objc_classlist", "ascii").copy(segment, 72);
    segment[72] = 0xdf;
    const layout = parseMachoLayout(
      Buffer.from(machoImage({ commands: [segment] })),
      "arm64",
    );

    expect(layout.sections[0]?.name).toBe("ß_objc_classlist");
  });

  it("accepts a FAT slice whose table identity and embedded header agree", () => {
    const fat = fatImage([{ cpu: CPU.arm64, bytes: machoImage({}) }]);
    expect(parseMachoLayout(Buffer.from(fat), "arm64").segments).toEqual([]);
  });

  it("selects only the admitted CPU type and rejects a 32-bit slice", () => {
    const sixtyFour = fatImage([
      { cpu: CPU.x86_64, bytes: machoImage({ cpu: CPU.x86_64 }) },
    ]);
    expect(() => parseMachoLayout(Buffer.from(sixtyFour), "x86")).toThrow(
      /Requested FAT architecture is absent/u,
    );
    expect(() => parseMachoLayout(Buffer.from(sixtyFour), "arm")).toThrow(
      /Requested FAT architecture is absent/u,
    );
    const thirtyTwo = fatImage([
      {
        cpu: CPU.i386,
        bytes: machoImage({ cpu: CPU.i386, wide: false }),
      },
    ]);
    expect(() => parseMachoLayout(Buffer.from(thirtyTwo), "x86")).toThrow(
      /Unsupported 32-bit Mach-O metadata for requested CPU type x86/u,
    );
  });

  it("rejects FAT subtype disagreement and unaligned slice offsets", () => {
    const original = fatImage([{ cpu: CPU.arm64, bytes: machoImage({}) }]);
    const mismatched = original.slice();
    new DataView(mismatched.buffer).setUint32(12, 2, false);
    expect(() => parseMachoLayout(Buffer.from(mismatched), "arm64")).toThrow(
      /disagrees/u,
    );

    const unaligned = original.slice();
    new DataView(unaligned.buffer).setUint32(16, 4097, false);
    expect(() => parseMachoLayout(Buffer.from(unaligned), "arm64")).toThrow(
      /not aligned/u,
    );
  });

  it.each([
    { layout: "arm64e, arm64e.x1", cpus: [CPU.arm64e, ARM64E_X1], index: 0 },
    { layout: "arm64e.x1, arm64e", cpus: [ARM64E_X1, CPU.arm64e], index: 1 },
    { layout: "arm64, arm64e.x1", cpus: [CPU.arm64, ARM64E_X1], index: 0 },
    { layout: "arm64e.x1, arm64", cpus: [ARM64E_X1, CPU.arm64], index: 1 },
    {
      layout: "x86_64, arm64e, arm64e.x1",
      cpus: [CPU.x86_64, CPU.arm64e, ARM64E_X1],
      index: 1,
    },
    {
      layout: "x86_64h, x86_64",
      cpus: [X86_64H, CPU.x86_64],
      index: 1,
      architecture: "x86_64",
    },
  ])(
    "selects one slice when FAT slices $layout share a CPU type",
    ({ cpus, index, architecture = "arm64" }) => {
      const fat = Buffer.from(
        fatImage(cpus.map((cpu) => ({ cpu, bytes: machoImage({ cpu }) }))),
      );
      expect(selectMachoSlice(fat, architecture).fatDeclaration).toMatchObject({
        index,
        cpuSubtype: cpus[index]?.subtype,
      });
      expect(parseMachoLayout(fat, architecture).segments).toEqual([]);
    },
  );

  it("rejects slices of the requested CPU type that share a subtype", () => {
    const fat = fatImage(
      [CPU.arm64e, CPU.arm64e].map((cpu) => ({
        cpu,
        bytes: machoImage({ cpu }),
      })),
    );
    expect(() => parseMachoLayout(Buffer.from(fat), "arm64")).toThrow(
      /Ambiguous FAT architecture slice/u,
    );
  });
});

describe("native Mach-O fixup load command boundaries", () => {
  const decode = (command: Uint8Array) =>
    decodeAppleDispatchMetadata(
      Buffer.from(machoImage({ commands: [command] })),
      100,
      { path: "/fixture/malformed.macho", sha256: "a".repeat(64) },
    );

  it.each<[string, number, number]>([
    ["chained-fixups", 0x80000034, 16],
    ["dyld-info", 0x22, 48],
    ["dyld-info-only", 0x80000022, 48],
    ["dylib", LC.LOAD_DYLIB, 24],
  ])(
    "rejects truncated %s commands instead of reporting absent, complete fixups",
    (_name, kind, minimumSize) => {
      const command = Buffer.alloc(minimumSize - 8);
      command.writeUInt32LE(kind, 0);
      command.writeUInt32LE(command.length, 4);
      expect(() => decode(command)).toThrow(/Truncated/u);
    },
  );

  it("preserves valid library identity and rejects install names outside the command", () => {
    const original = dylibCommand(LC.LOAD_DYLIB, "/usr/lib/libobjc.A.dylib");
    const layout = parseMachoLayout(
      Buffer.from(machoImage({ commands: [original] })),
      "arm64",
    );
    expect(layout.fixups.dylibs).toEqual(["/usr/lib/libobjc.A.dylib"]);
    for (const offset of [8, original.length]) {
      const command = Buffer.from(original);
      command.writeUInt32LE(offset, 8);
      expect(() => decode(command)).toThrow(/outside its load command/u);
    }
  });

  it("does not consume the following command's NUL as a dylib name terminator", () => {
    const unterminated = Buffer.alloc(32, 0x41);
    unterminated.writeUInt32LE(LC.LOAD_DYLIB, 0);
    unterminated.writeUInt32LE(unterminated.length, 4);
    unterminated.writeUInt32LE(24, 8);
    // machoImage includes zero padding after sizeofcmds; it is outside this command.
    expect(() => decode(unterminated)).toThrow(/Unterminated dylib/u);
  });
});
