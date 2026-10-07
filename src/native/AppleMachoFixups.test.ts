import { describe, expect, it } from "vitest";

import {
  decodeChainedPointer,
  parsePointerFixups,
} from "./AppleMachoFixups.js";
import { parsePropertyAttributes } from "./AppleObjcProperties.js";
import type { Segment } from "./AppleMachoSelection.js";

const BASE = 0x100000000n;
const IMPORTS = [
  {
    symbol: "_OBJC_CLASS_$_NSObject",
    library: "/usr/lib/libobjc.A.dylib",
    weak: false,
    addend: 0n,
  },
  {
    symbol: "_free",
    library: "/usr/lib/libSystem.B.dylib",
    weak: true,
    addend: 4n,
  },
];

const field = (value: bigint, from: number): bigint => value << BigInt(from);

describe("chained pointer decoding", () => {
  it("decodes DYLD_CHAINED_PTR_64 and _64_OFFSET rebases and binds", () => {
    const rebase = 0x4000n | field(0x80n, 36) | field(3n, 51);
    expect(decodeChainedPointer(BASE + 0x4000n, 2, BASE, IMPORTS)).toEqual({
      kind: "rebase",
      target: BASE + 0x4000n,
    });
    expect(decodeChainedPointer(rebase, 6, BASE, IMPORTS)).toEqual({
      kind: "rebase",
      target: (0x80n << 56n) + BASE + 0x4000n,
    });
    const bind = 1n | field(2n, 24) | field(1n, 63);
    expect(decodeChainedPointer(bind, 6, BASE, IMPORTS)).toEqual({
      kind: "bind",
      symbol: "_free",
      library: "/usr/lib/libSystem.B.dylib",
      weak: true,
      addend: 6n,
    });
  });

  it("decodes arm64e plain, authenticated and 24-bit binds", () => {
    expect(decodeChainedPointer(0x8000n, 9, BASE, IMPORTS)).toEqual({
      kind: "rebase",
      target: BASE + 0x8000n,
    });
    expect(decodeChainedPointer(BASE + 0x8000n, 1, BASE, IMPORTS)).toEqual({
      kind: "rebase",
      target: BASE + 0x8000n,
    });
    const authRebase = 0x8000n | field(0x1234n, 32) | field(1n, 63);
    expect(decodeChainedPointer(authRebase, 1, BASE, IMPORTS)).toEqual({
      kind: "rebase",
      target: BASE + 0x8000n,
    });
    const authBind = 0n | field(1n, 62) | field(1n, 63);
    expect(decodeChainedPointer(authBind, 9, BASE, IMPORTS)).toMatchObject({
      kind: "bind",
      symbol: "_OBJC_CLASS_$_NSObject",
      addend: 0n,
    });
    const bind24 = 1n | field(0x7ffffn, 32) | field(1n, 62);
    expect(decodeChainedPointer(bind24, 12, BASE, IMPORTS)).toMatchObject({
      kind: "bind",
      symbol: "_free",
      addend: 3n,
    });
    expect(() =>
      decodeChainedPointer(field(1n, 62) | 9n, 9, BASE, IMPORTS),
    ).toThrow("Chained bind ordinal 9 has no import");
    expect(() => decodeChainedPointer(1n, 3, BASE, IMPORTS)).toThrow(
      "Unsupported chained pointer format 3",
    );
  });
});

/** Build `LC_DYLD_CHAINED_FIXUPS` data with one fixup segment and the given imports. */
const chainedData = (format: 1 | 2 | 3): Buffer => {
  const symbols = Buffer.from("\0_OBJC_CLASS_$_NSObject\0_free\0");
  const importSize = format === 3 ? 16 : format === 2 ? 8 : 4;
  const imports = Buffer.alloc(importSize * 2);
  const entry = (
    index: number,
    {
      ordinal,
      weak,
      nameOffset,
      addend,
    }: {
      ordinal: number;
      weak: boolean;
      nameOffset: number;
      addend: number;
    },
  ) => {
    const at = index * importSize;
    if (format === 3) {
      imports.writeBigUInt64LE(
        BigInt(ordinal & 0xffff) |
          (BigInt(weak ? 1 : 0) << 16n) |
          (BigInt(nameOffset) << 32n),
        at,
      );
      imports.writeBigInt64LE(BigInt(addend), at + 8);
    } else {
      imports.writeUInt32LE(
        ((nameOffset << 9) | ((weak ? 1 : 0) << 8) | (ordinal & 0xff)) >>> 0,
        at,
      );
      if (format === 2) imports.writeInt32LE(addend, at + 4);
    }
  };
  entry(0, { ordinal: 1, weak: false, nameOffset: 1, addend: 0 });
  entry(1, { ordinal: 2, weak: true, nameOffset: 24, addend: 7 });
  // starts_in_image: two segments, only the second has fixups.
  const starts = Buffer.alloc(12 + 24);
  starts.writeUInt32LE(2, 0);
  starts.writeUInt32LE(0, 4);
  starts.writeUInt32LE(12, 8);
  starts.writeUInt32LE(24, 12);
  starts.writeUInt16LE(0x4000, 16);
  starts.writeUInt16LE(6, 18);
  const header = Buffer.alloc(28);
  header.writeUInt32LE(0, 0);
  header.writeUInt32LE(28, 4);
  header.writeUInt32LE(28 + starts.length, 8);
  header.writeUInt32LE(28 + starts.length + imports.length, 12);
  header.writeUInt32LE(2, 16);
  header.writeUInt32LE(format, 20);
  header.writeUInt32LE(0, 24);
  return Buffer.concat([header, starts, imports, symbols]);
};

const SEGMENTS: Segment[] = [
  { address: BASE, size: 0x4000n, offset: 0, executable: true },
  { address: BASE + 0x4000n, size: 0x4000n, offset: 0x4000, executable: false },
];

describe("pointer fixup tables", () => {
  for (const format of [1, 2, 3] as const)
    it(`reads chained import format ${format}`, () => {
      const data = chainedData(format);
      const fixups = parsePointerFixups(
        data,
        {
          chained: { offset: 0, size: data.length },
          binds: [],
          dylibs: ["/usr/lib/libobjc.A.dylib", "/usr/lib/libSystem.B.dylib"],
        },
        SEGMENTS,
        BASE,
      );
      expect(fixups).toMatchObject({
        kind: "chained",
        formats: ["DYLD_CHAINED_PTR_64_OFFSET"],
      });
      expect(fixups.decode(BASE + 0x4008n, 1n | field(1n, 63))).toMatchObject({
        kind: "bind",
        symbol: "_free",
        library: "/usr/lib/libSystem.B.dylib",
        weak: true,
        addend: format === 1 ? 0n : 7n,
      });
      // Pointers outside fixup segments are stored plainly.
      expect(fixups.decode(BASE + 0x10n, 0x1234n)).toEqual({
        kind: "rebase",
        target: 0x1234n,
      });
    });

  it("interprets legacy bind, weak-bind and lazy-bind opcodes", () => {
    const opcodes = Buffer.from([
      0x11, // SET_DYLIB_ORDINAL_IMM 1
      0x40,
      ...Buffer.from("_OBJC_CLASS_$_NSObject\0"),
      0x51, // SET_TYPE_IMM pointer
      0x71,
      0x08, // SET_SEGMENT_AND_OFFSET segment 1 + 8
      0x90, // DO_BIND
      0xc0,
      0x02,
      0x08, // DO_BIND_ULEB_TIMES_SKIPPING_ULEB 2 times, skip 8
      0x00,
    ]);
    const lazy = Buffer.from([
      0x71,
      0x30,
      0x12,
      0x40,
      ...Buffer.from("_free\0"),
      0x90,
      0x00,
      0x71,
      0x38,
      0x12,
      0x40,
      ...Buffer.from("_malloc\0"),
      0x90,
      0x00,
    ]);
    const data = Buffer.concat([opcodes, lazy]);
    const fixups = parsePointerFixups(
      data,
      {
        chained: null,
        binds: [
          { offset: 0, size: opcodes.length, stream: "bind" },
          { offset: opcodes.length, size: lazy.length, stream: "lazy" },
        ],
        dylibs: ["/usr/lib/libobjc.A.dylib", "/usr/lib/libSystem.B.dylib"],
      },
      SEGMENTS,
      BASE,
    );
    expect(fixups.kind).toBe("dyld-info");
    expect(fixups.failures).toEqual([]);
    for (const offset of [0x08n, 0x10n, 0x20n])
      expect(fixups.decode(BASE + 0x4000n + offset, 0n)).toMatchObject({
        kind: "bind",
        symbol: "_OBJC_CLASS_$_NSObject",
        library: "/usr/lib/libobjc.A.dylib",
      });
    expect(fixups.decode(BASE + 0x4038n, 0n)).toMatchObject({
      symbol: "_malloc",
      library: "/usr/lib/libSystem.B.dylib",
    });
    expect(fixups.decode(BASE + 0x4018n, 0x99n)).toEqual({
      kind: "rebase",
      target: 0x99n,
    });
  });
});

describe("Objective-C property attributes", () => {
  it("parses type, ownership, accessors and quoted class names", () => {
    expect(
      parsePropertyAttributes(
        "title",
        'T@"NSString<NSCopying, NSSecureCoding>",C,N,GcustomTitle,V_title',
      ),
    ).toEqual({
      name: "title",
      type_encoding: '@"NSString<NSCopying, NSSecureCoding>"',
      attributes: [
        expect.objectContaining({
          name: "T",
          value: '@"NSString<NSCopying, NSSecureCoding>"',
        }),
        expect.objectContaining({ name: "C", is_copy: true }),
        expect.objectContaining({ name: "N" }),
        expect.objectContaining({ name: "G", value: "customTitle" }),
        expect.objectContaining({ name: "V", value: "_title" }),
      ],
      is_readonly: false,
      getter: "customTitle",
      setter: null,
    });
    expect(parsePropertyAttributes("count", "Tq,R,N")).toMatchObject({
      type_encoding: "q",
      is_readonly: true,
    });
    expect(
      parsePropertyAttributes("delegate", "T@,W,N,V_delegate").attributes[1],
    ).toMatchObject({
      is_weak: true,
    });
  });
});
