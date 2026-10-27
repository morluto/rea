import { readFatContainerHeader } from "../domain/apple/machoContainer.js";
import { describe, expect, it } from "vitest";

import {
  CPU,
  LC,
  dylibCommand,
  dylibUseCommand,
  fatImage,
  machoImage,
  machoImageWithUnknownCommand,
} from "../artifacts/apple/MachoImage.fixture.js";
import { readMachoImage } from "../artifacts/apple/MachoLoadCommandReader.js";
import {
  parseMachoLayout,
  selectMachoSlice,
  UnsupportedMachoMetadataFormatError,
} from "./AppleMachoSelection.js";
import { decodeAppleDispatchMetadata } from "./AppleDispatchMetadata.js";

/** macOS 27 system binaries ship CPU_SUBTYPE_ARM64E_X1 (12) with the PAC ABI bit. */
const ARM64E_X1 = { type: 0x0100000c, subtype: 0x8000000c } as const;
const X86_64H = { type: 0x01000007, subtype: 8 } as const;

it("keeps unknown magic distinct from recognized unsupported Mach-O formats", () => {
  expect(() => parseMachoLayout(Buffer.alloc(10), "arm64")).toThrow(
    "Truncated Mach-O header",
  );

  const unknown = Buffer.alloc(32);
  let failure: unknown;
  try {
    parseMachoLayout(unknown, "arm64");
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(TypeError);
  expect(failure).not.toBeInstanceOf(UnsupportedMachoMetadataFormatError);
});

it.each([
  { magic: 0xfeedface, headerSize: 28 },
  { magic: 0xcefaedfe, headerSize: 28 },
  { magic: 0xfeedfacf, headerSize: 32 },
  { magic: 0xcffaedfe, headerSize: 32 },
])(
  "reports a recognized truncated header before CPU admission ($magic)",
  ({ magic, headerSize }) => {
    const bytes = Buffer.alloc(headerSize - 1);
    bytes.writeUInt32BE(magic);
    expect(() => parseMachoLayout(bytes, "unrecognized")).toThrow(
      new RangeError("Truncated Mach-O header"),
    );
  },
);

const registerThinCpuFamilyControls = (): void => {
  it.each([
    { cpu: CPU.x86_64, architecture: "arm64" },
    { cpu: CPU.arm64, architecture: "x86_64" },
    { cpu: CPU.arm64, architecture: "unrecognized" },
  ])(
    "rejects a thin image outside the requested $architecture CPU family",
    ({ cpu, architecture }) => {
      const bytes = Buffer.from(machoImage({ cpu }));
      expect(() => parseMachoLayout(bytes, architecture)).toThrow(
        `Mach-O CPU type does not match requested architecture ${architecture}`,
      );
      expect(() =>
        decodeAppleDispatchMetadata(
          bytes,
          10,
          { path: "/thin", sha256: "fixture" },
          architecture,
        ),
      ).toThrow(
        `Mach-O CPU type does not match requested architecture ${architecture}`,
      );
    },
  );

  it("accepts a thin x86_64 image for the requested CPU family", () => {
    const bytes = Buffer.from(machoImage({ cpu: CPU.x86_64 }));
    expect(parseMachoLayout(bytes, "x86_64").selectedImage).toMatchObject({
      container: "thin",
      cpuType: CPU.x86_64.type,
      cpuSubtype: CPU.x86_64.subtype,
    });
  });
};

it.each([false, true])(
  "retains the shared FAT declaration without imposing Hopper policy (wide=%s)",
  (wide) => {
    const thin = machoImage({ cpu: CPU.arm64e });
    const fat = Buffer.from(fatImage([{ cpu: CPU.arm64e, bytes: thin }], wide));
    if (wide) fat.writeUInt32BE(0x89abcdef, 8 + 28);
    expect(selectMachoSlice(fat, "arm64").fatDeclaration).toEqual({
      index: 0,
      offset: 4096,
      size: thin.byteLength,
      cpuType: CPU.arm64e.type,
      cpuSubtype: CPU.arm64e.subtype,
      alignmentExponent: 12,
      reserved: wide ? 0x89abcdef : null,
      tableEnd: 8 + (wide ? 32 : 20),
    });
  },
);

describe("native Mach-O slice selection", () => {
  it("rejects misaligned load commands", () => {
    expect(() =>
      parseMachoLayout(
        Buffer.from(machoImageWithUnknownCommand(true, 12)),
        "arm64",
      ),
    ).toThrow(/invalid cmdsize/u);
  });

  it("accepts an aligned load command", () => {
    expect(
      parseMachoLayout(
        Buffer.from(machoImageWithUnknownCommand(true, 16)),
        "arm64",
      ).segments,
    ).toEqual([]);
  });

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

  registerThinCpuFamilyControls();

  it("retains the selected image range and complete raw CPU identity", () => {
    const thin = Buffer.from(machoImage({ cpu: CPU.arm64e }));
    expect(parseMachoLayout(thin, "arm64").selectedImage).toEqual({
      container: "thin",
      offset: 0,
      byteLength: thin.length,
      cpuType: CPU.arm64e.type,
      cpuSubtype: CPU.arm64e.subtype,
      containerTableSha256: null,
    });

    const fat = Buffer.from(
      fatImage([{ cpu: ARM64E_X1, bytes: machoImage({ cpu: ARM64E_X1 }) }]),
    );
    const selection = parseMachoLayout(fat, "arm64").selectedImage;
    expect(selection).toMatchObject({
      container: "fat",
      cpuType: ARM64E_X1.type,
      cpuSubtype: ARM64E_X1.subtype,
    });
    expect(selection.offset).toBeGreaterThan(0);
    expect(selection.byteLength).toBeGreaterThan(0);
    expect(selection.containerTableSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("rejects a FAT 32-bit declaration whose embedded CPU identity disagrees", () => {
    const fat = fatImage([
      { cpu: CPU.i386, bytes: machoImage({ cpu: CPU.i386, wide: false }) },
    ]);
    const sliceOffset = new DataView(fat.buffer).getUint32(16, false);
    new DataView(fat.buffer).setUint32(sliceOffset + 4, CPU.arm64.type, true);

    expect(() => parseMachoLayout(Buffer.from(fat), "x86")).toThrow(
      /FAT architecture 0 CPU type\/subtype disagrees with its Mach-O header/u,
    );
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

  it("preserves distinct opaque install-name bytes and literal Unicode names", () => {
    const commands = [0x80, 0x81].map((byte) => {
      const command = Buffer.from(dylibCommand(LC.LOAD_DYLIB, "/lib?"));
      command[28] = byte;
      return command;
    });
    commands.push(
      Buffer.from(dylibCommand(LC.LOAD_DYLIB, "/lib�")),
      Buffer.from(dylibCommand(LC.LOAD_DYLIB, "\ufeff/libé")),
    );
    const layout = parseMachoLayout(
      Buffer.from(machoImage({ commands })),
      "arm64",
    );
    expect(layout.fixups.dylibs).toEqual([
      {
        bytes_base64: Buffer.from([0x2f, 0x6c, 0x69, 0x62, 0x80]).toString(
          "base64",
        ),
      },
      {
        bytes_base64: Buffer.from([0x2f, 0x6c, 0x69, 0x62, 0x81]).toString(
          "base64",
        ),
      },
      "/lib�",
      "\ufeff/libé",
    ]);
  });

  it.each<[string, Uint8Array]>([
    ["load", dylibCommand(LC.LOAD_DYLIB, "/lib?")],
    ["weak", dylibCommand(LC.LOAD_WEAK_DYLIB, "/lib?")],
    ["reexport", dylibCommand(LC.REEXPORT_DYLIB, "/lib?")],
    ["lazy", dylibCommand(LC.LAZY_LOAD_DYLIB, "/lib?")],
    ["upward", dylibCommand(LC.LOAD_UPWARD_DYLIB, "/lib?")],
    ["modern use", dylibUseCommand(LC.LOAD_DYLIB, "/lib?", 0x8)],
  ])(
    "retains opaque %s install-name identity while refusing text resolution",
    async (_kind, original) => {
      const command = Buffer.from(original);
      const nameOffset = command.readUInt32LE(8);
      command[nameOffset + 4] = 0x80;
      const bytes = Buffer.from(machoImage({ commands: [command] }));
      expect(parseMachoLayout(bytes, "arm64").fixups.dylibs).toEqual([
        {
          bytes_base64: Buffer.from([0x2f, 0x6c, 0x69, 0x62, 0x80]).toString(
            "base64",
          ),
        },
      ]);
      expect(
        await readMachoImage(
          async (offset, length) => bytes.subarray(offset, offset + length),
          bytes.length,
        ),
      ).toMatchObject({
        status: "malformed",
        reason: expect.stringContaining("not UTF-8"),
      });
    },
  );
});

it.each([0, 129])(
  "preserves native FAT selection policy separately from generic identity admission (count %i)",
  (count) => {
    const bytes = Buffer.alloc(8);
    bytes.writeUInt32BE(0xcafebabe);
    bytes.writeUInt32BE(count, 4);
    expect(readFatContainerHeader(bytes, bytes.length)).toEqual(
      count === 0
        ? { state: "malformed", reason: "FAT header declares no architectures" }
        : { state: "not-fat" },
    );
    expect(() => selectMachoSlice(bytes, "arm64")).toThrow(
      count === 0
        ? new TypeError(
            "Requested FAT architecture is absent (FAT header byte order: big-endian)",
          )
        : new RangeError(
            "Malformed FAT architecture table (FAT header byte order: big-endian)",
          ),
    );
  },
);
