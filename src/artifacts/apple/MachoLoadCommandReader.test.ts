import { describe, expect, it } from "vitest";

import {
  CPU,
  FILE_TYPE,
  LC,
  codeSignatureCommand,
  buildVersionCommand,
  dyldEnvironmentCommand,
  dylibCommand,
  dylibUseCommand,
  fatImage,
  machoImage,
  readerOf,
  rpathCommand,
} from "./MachoImage.fixture.js";
import {
  MAX_LOAD_COMMAND_BYTES,
  hasMachoMagic,
  readMachoImage,
} from "./MachoLoadCommandReader.js";

const read = (bytes: Uint8Array) =>
  readMachoImage(readerOf(bytes), bytes.length);

// version_min_command has no simulator flag. dyld uses the Mach-O CPU type
// to distinguish old simulator images from their device counterparts.
it.each([
  [0x25, 7, false, 7],
  [0x25, 0x01000007, true, 7],
  [0x25, 0x0100000c, true, 2],
  [0x2f, 0x01000007, true, 8],
  [0x2f, 0x0100000c, true, 3],
  [0x2f, 7, false, 3],
  [0x30, 7, false, 9],
  [0x30, 0x01000007, true, 9],
  [0x30, 12, false, 4],
  [0x24, 0x01000007, true, 1],
] as const)(
  "classifies legacy command %i on CPU %i (wide=%s) as platform %i",
  async (command, cpuType, wide, platform) => {
    const bytes = new Uint8Array(16);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, command, true);
    view.setUint32(4, bytes.length, true);
    view.setUint32(8, 0x00090000, true);
    const facts = await read(
      machoImage({
        cpu: { type: cpuType, subtype: 3 },
        wide,
        commands: [bytes],
      }),
    );
    if (facts.status !== "parsed") throw new Error(facts.status);
    expect(facts.slices[0]).toMatchObject({ platform, platforms: [platform] });
  },
);

describe("Mach-O load command reader: decodes thin-image load commands", () => {
  it("decodes dylib loading commands of a thin image", async () => {
    const image = machoImage({
      fileType: FILE_TYPE.dylib,
      commands: [
        dylibCommand(LC.ID_DYLIB, "@rpath/Core.framework/Core"),
        dylibCommand(LC.LOAD_DYLIB, "/usr/lib/libSystem.B.dylib", {
          current: 0x050f0400,
          compatibility: 0x10000,
        }),
        dylibCommand(LC.LOAD_WEAK_DYLIB, "@rpath/libweak.dylib"),
        dylibCommand(LC.REEXPORT_DYLIB, "@loader_path/libre.dylib"),
        dylibCommand(LC.LOAD_UPWARD_DYLIB, "@rpath/libup.dylib"),
        dylibCommand(LC.LAZY_LOAD_DYLIB, "@rpath/liblazy.dylib"),
        rpathCommand("@loader_path/Frameworks"),
        rpathCommand("/usr/lib/swift"),
        dyldEnvironmentCommand("DYLD_FRAMEWORK_PATH=@executable_path"),
        codeSignatureCommand(),
      ],
    });
    const facts = await read(image);
    expect(facts.status).toBe("parsed");
    if (facts.status !== "parsed") return;
    expect(facts.slices).toHaveLength(1);
    const [slice] = facts.slices;
    expect(slice).toMatchObject({
      architecture: "arm64",
      file_type: "dylib",
      install_name: "@rpath/Core.framework/Core",
      rpaths: ["@loader_path/Frameworks", "/usr/lib/swift"],
      dyld_environment: ["DYLD_FRAMEWORK_PATH=@executable_path"],
      code_signature_present: true,
    });
    expect(
      slice?.dependencies.map(
        ({ command, install_name: name, weak, reexport, upward }) => [
          command,
          name,
          weak,
          reexport,
          upward,
        ],
      ),
    ).toEqual([
      ["LC_LOAD_DYLIB", "/usr/lib/libSystem.B.dylib", false, false, false],
      ["LC_LOAD_WEAK_DYLIB", "@rpath/libweak.dylib", true, false, false],
      ["LC_REEXPORT_DYLIB", "@loader_path/libre.dylib", false, true, false],
      ["LC_LOAD_UPWARD_DYLIB", "@rpath/libup.dylib", false, false, true],
      ["LC_LAZY_LOAD_DYLIB", "@rpath/liblazy.dylib", false, false, false],
    ]);
    expect(slice?.dependencies[0]).toMatchObject({
      encoding: "dylib_command",
      current_version: "1295.4.0",
      compatibility_version: "1.0.0",
    });
  });

  it("decodes dylib_use_command flags", async () => {
    const facts = await read(
      machoImage({
        commands: [
          dylibUseCommand(LC.LOAD_DYLIB, "@rpath/libdelay.dylib", 0x8),
          dylibUseCommand(LC.LOAD_DYLIB, "@rpath/libweakup.dylib", 0x1 | 0x4),
          dylibUseCommand(LC.LOAD_DYLIB, "@rpath/libre.dylib", 0x2),
        ],
      }),
    );
    if (facts.status !== "parsed") throw new Error(facts.status);
    expect(
      facts.slices[0]?.dependencies.map(
        ({ encoding, weak, upward, reexport, delayed_init: delayed }) => ({
          encoding,
          weak,
          upward,
          reexport,
          delayed,
        }),
      ),
    ).toEqual([
      {
        encoding: "dylib_use_command",
        weak: false,
        upward: false,
        reexport: false,
        delayed: true,
      },
      {
        encoding: "dylib_use_command",
        weak: true,
        upward: true,
        reexport: false,
        delayed: false,
      },
      {
        encoding: "dylib_use_command",
        weak: false,
        upward: false,
        reexport: true,
        delayed: false,
      },
    ]);
  });
});

describe("Mach-O load command reader: reads and validates universal binary slices", () => {
  it("reads every slice of FAT and FAT_64 containers in either byte order", async () => {
    for (const [wide, littleEndian] of [
      [false, false],
      [true, false],
      [false, true],
      [true, true],
    ] as const) {
      const facts = await read(
        fatImage(
          [
            {
              cpu: CPU.arm64e,
              bytes: machoImage({
                cpu: CPU.arm64e,
                commands: [rpathCommand("@executable_path/a")],
              }),
            },
            {
              cpu: CPU.x86_64,
              bytes: machoImage({
                cpu: CPU.x86_64,
                commands: [rpathCommand("@executable_path/b")],
              }),
            },
          ],
          wide,
          littleEndian,
        ),
      );
      if (facts.status !== "parsed") throw new Error(facts.status);
      expect(
        facts.slices.map(({ architecture, rpaths }) => [architecture, rpaths]),
      ).toEqual([
        ["arm64e", ["@executable_path/a"]],
        ["x86_64", ["@executable_path/b"]],
      ]);
    }
  });

  it("retains physical slice identity and declared build platform", async () => {
    const thin = machoImage({ commands: [buildVersionCommand(7)] });
    const parsedThin = await read(thin);
    expect(
      parsedThin.status === "parsed" && parsedThin.slices[0],
    ).toMatchObject({
      slice_offset: 0,
      slice_size: thin.length,
      cpu_type: CPU.arm64.type,
      cpu_subtype: CPU.arm64.subtype,
      fat_cpu_type: null,
      fat_cpu_subtype: null,
      platform: 7,
    });
    const fat = fatImage([{ cpu: CPU.arm64, bytes: thin }]);
    const parsedFat = await read(fat);
    expect(parsedFat.status === "parsed" && parsedFat.slices[0]).toMatchObject({
      slice_offset: 4096,
      slice_size: thin.length,
      fat_cpu_type: CPU.arm64.type,
      fat_cpu_subtype: CPU.arm64.subtype,
    });
  });

  it("rejects FAT table/header identity mismatches and unaligned ranges", async () => {
    const original = fatImage([{ cpu: CPU.arm64, bytes: machoImage({}) }]);
    for (const [fieldOffset, value] of [
      [8, CPU.x86_64.type],
      [12, 99],
    ] as const) {
      const mismatch = original.slice();
      new DataView(mismatch.buffer).setUint32(fieldOffset, value, false);
      expect(await read(mismatch)).toMatchObject({
        status: "malformed",
        reason: expect.stringContaining("disagrees"),
      });
    }
    const unaligned = original.slice();
    new DataView(unaligned.buffer).setUint32(16, 4097, false);
    expect(await read(unaligned)).toMatchObject({
      status: "malformed",
      reason: expect.stringContaining("not aligned"),
    });
  });

  it("preserves unknown CPU table facts when the embedded slice is Mach-O", async () => {
    const cpu = { type: 0x7fffffff, subtype: 11 };
    const facts = await read(fatImage([{ cpu, bytes: machoImage({ cpu }) }]));
    expect(facts.status === "parsed" && facts.slices[0]).toMatchObject({
      architecture: "cpu-7fffffff",
      cpu_type: cpu.type,
      cpu_subtype: cpu.subtype,
      fat_cpu_type: cpu.type,
      fat_cpu_subtype: cpu.subtype,
    });
  });
});

describe("Mach-O load command reader inputs", () => {
  it("names 32-bit and non-Mach-O inputs without guessing", async () => {
    const i386 = await read(
      machoImage({ cpu: { type: 7, subtype: 3 }, wide: false }),
    );
    expect(i386.status === "parsed" && i386.slices[0]?.architecture).toBe(
      "i386",
    );
    // A Java class file shares the FAT magic; its version is not a slice count.
    const javaClass = Uint8Array.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 0x34]);
    expect(hasMachoMagic(javaClass)).toBe(true);
    expect(await read(javaClass)).toEqual({ status: "not-mach-o" });
    expect(await read(new TextEncoder().encode("#!/bin/sh\n"))).toEqual({
      status: "not-mach-o",
    });
    expect(await read(Uint8Array.from([0xcf, 0xfa]))).toEqual({
      status: "not-mach-o",
    });
    // A recognized magic without room for a header is a truncated image.
    expect(
      await read(Uint8Array.from([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00])),
    ).toEqual({ status: "malformed", reason: "Mach-O header is truncated" });
  });
});

describe("Mach-O load command reader failures", () => {
  const withCommandSize = (size: number): Uint8Array => {
    const image = machoImage({ commands: [rpathCommand("@loader_path")] });
    new DataView(image.buffer).setUint32(32 + 4, size, true);
    return image;
  };

  it("reports malformed command tables with the failing command", async () => {
    expect(await read(withCommandSize(0))).toMatchObject({
      status: "malformed",
      reason: expect.stringContaining("load command 0"),
    });
    expect(await read(withCommandSize(4096))).toMatchObject({
      status: "malformed",
      reason: expect.stringContaining("invalid cmdsize"),
    });
    const extraCommand = machoImage({ commands: [rpathCommand("x")] });
    new DataView(extraCommand.buffer).setUint32(16, 2, true);
    expect(await read(extraCommand)).toMatchObject({
      status: "malformed",
      reason: "load command 1 starts beyond sizeofcmds",
    });
  });

  it("requires 8-byte command alignment in 64-bit images", async () => {
    // A command the reader does not decode; only its size is checked.
    const command = new Uint8Array(12);
    const view = new DataView(command.buffer);
    view.setUint32(0, 0x7f000001, true);
    view.setUint32(4, 12, true);
    expect(await read(machoImage({ commands: [command] }))).toMatchObject({
      status: "malformed",
      reason: expect.stringContaining("invalid cmdsize 12"),
    });
    expect(
      await read(
        machoImage({
          cpu: { type: 7, subtype: 3 },
          wide: false,
          commands: [command],
        }),
      ),
    ).toMatchObject({ status: "parsed" });
  });

  it("accepts FAT tables up to 128 records that name a Mach-O CPU", async () => {
    const slices = Array.from({ length: 24 }, () => ({
      cpu: CPU.arm64,
      bytes: machoImage({}),
    }));
    const facts = await read(fatImage(slices));
    expect(facts.status === "parsed" && facts.slices).toHaveLength(24);
    // An empty table is not a Java class file, whose major version is nonzero.
    for (const magic of [
      [0xca, 0xfe, 0xba, 0xbe],
      [0xbf, 0xba, 0xfe, 0xca],
    ])
      expect(await read(Uint8Array.from([...magic, 0, 0, 0, 0]))).toEqual({
        status: "malformed",
        reason: "FAT header declares no architectures",
      });
  });

  it("rejects string commands too short to hold their string offset", async () => {
    const short = new Uint8Array(8);
    const view = new DataView(short.buffer);
    view.setUint32(0, LC.RPATH, true);
    view.setUint32(4, 8, true);
    expect(await read(machoImage({ commands: [short] }))).toMatchObject({
      status: "malformed",
      reason: "load command 0 is too short to hold a string offset",
    });
    view.setUint32(0, LC.CODE_SIGNATURE, true);
    expect(await read(machoImage({ commands: [short] }))).toMatchObject({
      status: "malformed",
      reason: "load command 0 is too short for LC_CODE_SIGNATURE",
    });
  });

  it("rejects strings that are unterminated, misplaced or not UTF-8", async () => {
    const unterminated = rpathCommand("abcd");
    unterminated.fill(0x41, 12);
    expect(await read(machoImage({ commands: [unterminated] }))).toMatchObject({
      status: "malformed",
      reason: expect.stringContaining("unterminated"),
    });
    const misplaced = rpathCommand("abcd");
    new DataView(misplaced.buffer).setUint32(8, 4, true);
    expect(await read(machoImage({ commands: [misplaced] }))).toMatchObject({
      status: "malformed",
      reason: expect.stringContaining("string offset 4"),
    });
    const invalid = rpathCommand("ab");
    invalid[12] = 0xff;
    expect(await read(machoImage({ commands: [invalid] }))).toMatchObject({
      status: "malformed",
      reason: expect.stringContaining("not UTF-8"),
    });
  });

  it("refuses truncated, oversized, big-endian and out-of-range images", async () => {
    const image = machoImage({ commands: [rpathCommand("@loader_path")] });
    expect(await read(image.subarray(0, 20))).toMatchObject({
      status: "malformed",
      reason: "Mach-O header is truncated",
    });
    const oversized = machoImage({});
    new DataView(oversized.buffer).setUint32(
      20,
      MAX_LOAD_COMMAND_BYTES + 8,
      true,
    );
    expect(await read(oversized)).toMatchObject({ status: "unsupported" });
    const beyond = machoImage({ commands: [rpathCommand("x")] });
    new DataView(beyond.buffer).setUint32(20, beyond.length, true);
    expect(await read(beyond)).toMatchObject({
      status: "malformed",
      reason: "load commands extend beyond the Mach-O slice",
    });
    const bigEndian = Uint8Array.from([0xfe, 0xed, 0xfa, 0xcf, 0, 0, 0, 0]);
    expect(await read(bigEndian)).toMatchObject({ status: "unsupported" });
    const fat = fatImage([{ cpu: CPU.arm64, bytes: machoImage({}) }]);
    expect(await read(fat.subarray(0, 4100))).toMatchObject({
      status: "malformed",
      reason: "FAT architecture 0 slice range extends beyond the file",
    });
  });
});

it.each([true, false])(
  "rejects unconsumed command bytes in wide=%s headers",
  async (wide) => {
    const bytes = machoImage({ wide, commands: [rpathCommand("ignored")] });
    new DataView(bytes.buffer).setUint32(16, 0, true);
    expect(await read(bytes)).toMatchObject({
      status: "malformed",
      reason: expect.stringContaining("sizeofcmds"),
    });
  },
);
