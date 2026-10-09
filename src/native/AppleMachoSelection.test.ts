import { describe, expect, it } from "vitest";

import {
  CPU,
  LC,
  dylibCommand,
  fatImage,
  machoImage,
} from "../artifacts/apple/MachoImage.fixture.js";
import { parseMachoLayout } from "./AppleMachoSelection.js";
import { decodeAppleDispatchMetadata } from "./AppleDispatchMetadata.js";

describe("native Mach-O slice selection", () => {
  it("accepts a FAT slice whose table identity and embedded header agree", () => {
    const fat = fatImage([{ cpu: CPU.arm64, bytes: machoImage({}) }]);
    expect(parseMachoLayout(Buffer.from(fat), "arm64").segments).toEqual([]);
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
