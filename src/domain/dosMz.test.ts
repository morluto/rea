import { describe, expect, it } from "vitest";

import { dosMz, pe } from "./binaryTarget.fixture.js";
import { parseExecutableHeader } from "./binaryTarget.js";
import { mzWindowsHeaderOffset, parseDosMzHeader } from "./dosMz.js";

describe("DOS MZ load-module validation", () => {
  it("separates initialized module and appended overlay bytes", () => {
    const image = dosMz(480);
    const bytes = Buffer.concat([image, Buffer.from("overlay")]);
    expect(parseDosMzHeader(bytes)).toEqual({
      ok: true,
      value: {
        headerBytes: 32,
        imageBytes: 512,
        moduleBytes: 480,
        overlayBytes: 7,
        relocationCount: 0,
        relocationTableOffset: 28,
        entrySegment: 0,
        entryOffset: 0,
      },
    });
  });

  it("accepts relocation records overlapping the Windows new-header field", () => {
    const bytes = Buffer.alloc(224);
    dosMz().copy(bytes, 0, 0, 28);
    bytes.writeUInt16LE(bytes.length, 2);
    bytes.writeUInt16LE(6, 8);
    bytes.writeUInt16LE(2, 6);
    bytes.writeUInt16LE(62, 24);
    bytes.writeUInt16LE(1, 62);
    bytes.writeUInt16LE(8, 66);
    expect(bytes.readUInt32LE(60)).toBe(65536);
    expect(mzWindowsHeaderOffset(bytes)).toBeNull();
    expect(parseExecutableHeader(bytes, "x64")).toMatchObject({
      ok: true,
      value: { format: "dos-mz" },
    });
    expect(parseDosMzHeader(bytes)).toMatchObject({
      ok: true,
      value: { headerBytes: 96, relocationCount: 2, moduleBytes: 128 },
    });
  });

  it("uses the actual file length rather than the bounded prefix length", () => {
    const bytes = dosMz(8192);
    expect(parseDosMzHeader(bytes.subarray(0, 64), bytes.length).ok).toBe(true);
    expect(parseDosMzHeader(bytes.subarray(0, 64))).toMatchObject({
      ok: false,
      error: "truncated DOS MZ load module",
    });
  });

  it("preserves PE classification when low relocation records do not overlap e_lfanew", () => {
    const bytes = pe(0x8664);
    bytes.writeUInt16LE(4, 8);
    bytes.writeUInt16LE(1, 6);
    bytes.writeUInt16LE(28, 24);
    expect(mzWindowsHeaderOffset(bytes)).toBe(64);
    expect(parseExecutableHeader(bytes, "x64")).toMatchObject({
      ok: true,
      value: { format: "pe", architecture: "x86_64" },
    });
    expect(parseDosMzHeader(bytes).ok).toBe(false);
  });

  it.each([
    ["page count", (bytes: Buffer) => bytes.writeUInt16LE(0, 4)],
    ["final-page size", (bytes: Buffer) => bytes.writeUInt16LE(512, 2)],
    ["header size", (bytes: Buffer) => bytes.writeUInt16LE(1, 8)],
    ["entry point", (bytes: Buffer) => bytes.writeUInt16LE(128, 20)],
    [
      "relocation-table bounds",
      (bytes: Buffer) => {
        bytes.writeUInt16LE(2, 6);
      },
    ],
    [
      "relocation target",
      (bytes: Buffer) => {
        bytes.writeUInt16LE(1, 6);
        bytes.writeUInt16LE(127, 28);
      },
    ],
  ] as const)("rejects invalid %s", (_name, damage) => {
    const bytes = dosMz();
    damage(bytes);
    expect(parseDosMzHeader(bytes).ok).toBe(false);
  });

  it("rejects a truncated relocation table even when the file size is known", () => {
    const bytes = dosMz();
    bytes.writeUInt16LE(1, 6);
    expect(parseDosMzHeader(bytes.subarray(0, 30), bytes.length)).toMatchObject(
      {
        ok: false,
        error: "truncated DOS MZ relocation table",
      },
    );
  });

  it.each(["NE", "LE", "LX"])(
    "distinguishes unsupported %s from DOS",
    (signature) => {
      const bytes = pe(0x8664);
      bytes.writeUInt16LE(4, 8);
      bytes.writeUInt16LE(64, 24);
      bytes.write(signature, 64, "ascii");
      expect(parseExecutableHeader(bytes, "x64")).toEqual({
        ok: false,
        error: `unsupported ${signature} executable in MZ image`,
      });
    },
  );

  it("does not fall back to DOS when a Windows declaration is damaged", () => {
    const bytes = Buffer.alloc(256);
    dosMz().copy(bytes, 0, 0, 28);
    bytes.writeUInt16LE(256, 2);
    bytes.writeUInt16LE(4, 8);
    bytes.writeUInt16LE(64, 24);
    bytes.writeUInt32LE(192, 60);
    expect(parseDosMzHeader(bytes).ok).toBe(false);
    expect(parseExecutableHeader(bytes, "x64")).toMatchObject({ ok: false });
    bytes.writeUInt32LE(0xfffffff0, 60);
    expect(parseExecutableHeader(bytes, "x64")).toMatchObject({ ok: false });
  });
});
