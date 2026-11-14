import { describe, expect, it } from "vitest";

import type { MachoSliceArchitecture } from "../../domain/apple/machoTargetSelection.js";
import { machoArm64Initializers } from "../initializers/NativeInitializers.fixture.js";
import { selectNativeImage } from "./MachoSliceSelection.js";

const CPU_ARM = 12;
const CPU_X86_64 = 0x01000007;
const CPU_ARM64 = 0x0100000c;
const ALIGN = 0x1000;

/**
 * A FAT32 file whose 4 KiB-aligned slices are the arm64 initializer image with
 * each declared CPU; a third entry overrides the embedded header's subtype.
 */
const fat = (cpus: readonly (readonly [number, number, number?])[]) => {
  const thin = machoArm64Initializers();
  const stride = Math.ceil(thin.length / ALIGN) * ALIGN;
  const offsets = cpus.map((_, index) => ALIGN + index * stride);
  const bytes = Buffer.alloc(ALIGN + cpus.length * stride);
  bytes.writeUInt32BE(0xcafebabe, 0);
  bytes.writeUInt32BE(cpus.length, 4);
  for (const [index, [cpuType, cpuSubtype, headerSubtype]] of cpus.entries()) {
    const entry = 8 + index * 20;
    bytes.writeUInt32BE(cpuType, entry);
    bytes.writeUInt32BE(cpuSubtype, entry + 4);
    bytes.writeUInt32BE(offsets[index]!, entry + 8);
    bytes.writeUInt32BE(thin.length, entry + 12);
    bytes.writeUInt32BE(12, entry + 16);
    const image = Buffer.from(thin);
    image.writeUInt32LE(cpuType, 4);
    image.writeUInt32LE(headerSubtype ?? cpuSubtype, 8);
    image.copy(bytes, offsets[index]);
  }
  return { bytes, offsets };
};

const select = (
  cpus: readonly (readonly [number, number, number?])[],
  architecture: MachoSliceArchitecture,
) => {
  const file = fat(cpus);
  const result = selectNativeImage(file.bytes, architecture);
  return {
    offsets: file.offsets,
    offset: result.ok ? result.value.fileOffset : undefined,
    limitations: result.ok ? result.value.limitations : [],
    message: result.ok ? undefined : result.error.message,
  };
};

describe("selectNativeImage subtype names", () => {
  it("reads arm64v8 as arm64 and arm64e.x1 as arm64e", () => {
    const v8 = select(
      [
        [CPU_ARM64, 1],
        [CPU_ARM64, 2],
      ],
      "arm64",
    );
    expect(v8.offset).toBe(v8.offsets[0]);
    const x1 = select(
      [
        [CPU_ARM64, 0],
        [CPU_ARM64, 12],
      ],
      "arm64e",
    );
    expect(x1.offset).toBe(x1.offsets[1]);
  });

  it("refuses arm64e beside arm64e.x1, which the value names alike", () => {
    expect(
      select(
        [
          [CPU_ARM64, 2],
          [CPU_ARM64, 12],
        ],
        "arm64e",
      ).message,
    ).toBe(
      "Universal Mach-O holds several arm64e slices (arm64 (subtype 0x2), arm64 (subtype 0xc)); no slice was selected.",
    );
  });

  it("ignores capability bits when naming a subtype", () => {
    const capable = select(
      [
        [CPU_ARM64, 0x80000002],
        [CPU_ARM64, 0x80000000],
      ],
      "arm64",
    );
    expect(capable.offset).toBe(capable.offsets[1]);
  });

  it("refuses a subtype name that several slices share and names the value that works", () => {
    const cpus = [
      [CPU_ARM64, 2],
      [CPU_ARM64, 0x80000002],
      [CPU_ARM64, 0],
    ] as const;
    const arm64e = select(cpus, "arm64e");
    expect(arm64e.message).toBe(
      "Universal Mach-O holds several arm64e slices (arm64 (subtype 0x2), arm64 (subtype 0x80000002), arm64 (subtype 0x0)); no slice was selected. Select architecture arm64.",
    );
    const arm64 = select(cpus, "arm64");
    expect(arm64.offset).toBe(arm64.offsets[2]);
    expect(arm64.limitations).toEqual([
      `Only the selected arm64 slice (arm64 (subtype 0x0) at file offset ${String(arm64.offsets[2])}) was read; this universal Mach-O also holds arm64 (subtype 0x2) at file offset ${String(arm64.offsets[0])} (no architecture value selects it), arm64 (subtype 0x80000002) at file offset ${String(arm64.offsets[1])} (no architecture value selects it).`,
    ]);
  });

  it("refuses a subtype that no slice of the family has", () => {
    expect(
      select(
        [
          [CPU_ARM64, 0],
          [CPU_ARM64, 1],
        ],
        "arm64e",
      ).message,
    ).toBe(
      "Universal Mach-O holds arm64 (subtype 0x0), arm64 (subtype 0x1); no slice has the arm64e subtype.",
    );
    // A lone family slice is read by its family name, so the refusal names it.
    expect(
      select(
        [
          [CPU_X86_64, 3],
          [CPU_ARM64, 0],
        ],
        "arm64e",
      ).message,
    ).toBe(
      "Universal Mach-O holds x86_64 (subtype 0x3), arm64 (subtype 0x0); no slice has the arm64e subtype. Select architecture arm64.",
    );
  });

  it("refuses slices that differ only in capability bits", () => {
    expect(
      select(
        [
          [CPU_ARM64, 0],
          [CPU_ARM64, 0x80000000],
        ],
        "arm64",
      ).message,
    ).toBe(
      "Universal Mach-O holds several arm64 slices (arm64 (subtype 0x0), arm64 (subtype 0x80000000)); no slice was selected.",
    );
  });

  it("reports a family with no slice of the named subtype rather than several", () => {
    expect(
      select(
        [
          [CPU_ARM64, 2],
          [CPU_ARM64, 12],
        ],
        "arm64",
      ).message,
    ).toBe(
      "Universal Mach-O holds arm64 (subtype 0x2), arm64 (subtype 0xc); no slice has the arm64 subtype.",
    );
  });
});

describe("selectNativeImage family reads and unread slices", () => {
  it("does not advertise a selector for a slice whose header disagrees with its declaration", () => {
    // Declared arm64e, but the embedded header says arm64.
    const mismatched = [CPU_ARM64, 2, 0] as const;
    const read = select([[CPU_ARM64, 0], mismatched], "arm64");
    expect(read.offset).toBe(read.offsets[0]);
    expect(read.limitations).toEqual([
      `Only the selected arm64 slice (arm64 (subtype 0x0) at file offset ${String(read.offsets[0])}) was read; this universal Mach-O also holds arm64 (subtype 0x2) at file offset ${String(read.offsets[1])} (unverified: FAT architecture 1 CPU type/subtype disagrees with its Mach-O header; no architecture value reads it).`,
    ]);
    expect(
      select([[CPU_ARM64, 0], [CPU_ARM64, 0], mismatched], "arm64").message,
    ).toBe(
      "Universal Mach-O holds several arm64 slices (arm64 (subtype 0x0), arm64 (subtype 0x0), arm64 (subtype 0x2)); no slice was selected.",
    );
  });

  it("fails as malformed when the requested slice's header disagrees with its declaration", () => {
    const file = fat([
      [CPU_ARM64, 0],
      [CPU_ARM64, 2, 0],
    ]);
    const result = selectNativeImage(file.bytes, "arm64e");
    expect(result.ok ? undefined : result.error).toEqual({
      kind: "malformed",
      message:
        "FAT architecture 1 CPU type/subtype disagrees with its Mach-O header",
    });
  });

  it("fails the whole file when a sibling's declared range leaves it", () => {
    const file = fat([
      [CPU_ARM64, 0],
      [CPU_ARM64, 2],
    ]);
    // Declare the second slice past the end of the file.
    file.bytes.writeUInt32BE(file.bytes.length, 8 + 20 + 12);
    const result = selectNativeImage(file.bytes, "arm64");
    expect(result.ok ? undefined : result.error).toEqual({
      kind: "malformed",
      message: "FAT architecture 1 slice range extends beyond the file",
    });
  });

  it("reads a lone arm64e slice by the arm64 family name", () => {
    const lone = select(
      [
        [CPU_X86_64, 3],
        [CPU_ARM64, 2],
      ],
      "arm64",
    );
    expect(lone.offset).toBe(lone.offsets[1]);
    expect(lone.limitations).toEqual([]);
  });

  it("reads a lone x86_64h slice by its family name", () => {
    const lone = select(
      [
        [CPU_ARM64, 0],
        [CPU_X86_64, 8],
      ],
      "x86_64",
    );
    expect(lone.offset).toBe(lone.offsets[1]);
    expect(lone.limitations).toEqual([]);
  });

  it("reads x86_64 beside x86_64h and reports that no value selects x86_64h", () => {
    const x86 = select(
      [
        [CPU_X86_64, 8],
        [CPU_X86_64, 3],
      ],
      "x86_64",
    );
    expect(x86.offset).toBe(x86.offsets[1]);
    expect(x86.limitations).toEqual([
      `Only the selected x86_64 slice (x86_64 (subtype 0x3) at file offset ${String(x86.offsets[1])}) was read; this universal Mach-O also holds x86_64 (subtype 0x8) at file offset ${String(x86.offsets[0])} (no architecture value selects it).`,
    ]);
  });

  it("refuses several 32-bit arm slices, which no value names", () => {
    expect(
      select(
        [
          [CPU_ARM, 9],
          [CPU_ARM, 11],
        ],
        "arm",
      ).message,
    ).toBe(
      "Universal Mach-O holds several arm slices (arm (subtype 0x9), arm (subtype 0xb)); no slice was selected.",
    );
  });
});
