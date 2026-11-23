import { describe, expect, it } from "vitest";

import type { MachoSliceArchitecture } from "../../domain/apple/machoTargetSelection.js";
import {
  fatImage,
  fatSliceRange,
  machoImage,
} from "../../artifacts/apple/MachoImage.fixture.js";
import { selectMachoSlice } from "../../domain/apple/machoSliceSelection.js";

const selectNativeImage = (
  bytes: Buffer,
  architecture: MachoSliceArchitecture | undefined,
) => selectMachoSlice(bytes, { mode: "architecture", architecture });

const CPU_ARM = 12;
const CPU_X86_64 = 0x01000007;
const CPU_ARM64 = 0x0100000c;
/** Each tuple names the FAT declaration and optionally another header subtype. */
const fat = (cpus: readonly (readonly [number, number, number?])[]) => {
  const bytes = Buffer.from(
    fatImage(
      cpus.map(([type, subtype, embedded = subtype]) => ({
        cpu: { type, subtype },
        bytes: machoImage({
          cpu: { type, subtype: embedded },
          wide: type !== CPU_ARM,
        }),
      })),
    ),
  );
  return {
    bytes,
    offsets: cpus.map((_, index) => fatSliceRange(bytes, index).offset),
  };
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
    kind: result.ok ? undefined : result.error.kind,
    message: result.ok ? undefined : result.error.message,
  };
};

describe("selectNativeImage subtype names", () => {
  it("reads arm64v8 and arm64e.x1 by their exact selectors", () => {
    const { bytes, offsets } = fat([
      [CPU_ARM64, 1],
      [CPU_ARM64, 12],
    ]);
    for (const [architecture, index, other] of [
      ["arm64", 0, "arm64e"],
      ["arm64e", 1, "arm64"],
    ] as const) {
      expect(selectNativeImage(bytes, architecture)).toMatchObject({
        ok: true,
        value: {
          fileOffset: offsets[index],
          limitations: [
            expect.stringContaining(`architecture ${other} selects it`),
          ],
        },
      });
    }
  });

  it("distinguishes ambiguous and absent selectors for the same subtype table", () => {
    const { bytes } = fat([
      [CPU_ARM64, 2],
      [CPU_ARM64, 12],
    ]);
    expect(selectNativeImage(bytes, "arm64e")).toEqual({
      ok: false,
      error: {
        kind: "ambiguous_architecture",
        message:
          "Universal Mach-O holds several arm64e slices (arm64 (subtype 0x2), arm64 (subtype 0xc)); no slice was selected.",
      },
    });
    expect(selectNativeImage(bytes, "arm64")).toEqual({
      ok: false,
      error: {
        kind: "architecture_not_present",
        message:
          "Universal Mach-O holds arm64 (subtype 0x2), arm64 (subtype 0xc); no slice has the arm64 subtype.",
      },
    });
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

  it.each([false, true])(
    "keeps the alternate selector ambiguous even with a mismatched header=%s",
    (mismatched) => {
      const { bytes, offsets } = fat([
        [CPU_ARM64, 2],
        [CPU_ARM64, 0x80000002, mismatched ? 0 : 0x80000002],
        [CPU_ARM64, 0],
      ]);
      const arm64e = selectNativeImage(bytes, "arm64e");
      expect(arm64e).toMatchObject({
        ok: false,
        error: {
          kind: "ambiguous_architecture",
          message: expect.stringMatching(/Select architecture arm64\.$/u),
        },
      });
      const lastSibling = mismatched
        ? "unverified: FAT architecture 1 CPU type/subtype disagrees with its Mach-O header; no architecture value reads it"
        : "no architecture value selects it";
      expect(selectNativeImage(bytes, "arm64")).toMatchObject({
        ok: true,
        value: {
          fileOffset: offsets[2],
          limitations: [
            `Only the selected arm64 slice (arm64 (subtype 0x0) at file offset ${String(offsets[2])}) was read; this universal Mach-O also holds arm64 (subtype 0x2) at file offset ${String(offsets[0])} (no architecture value selects it), arm64 (subtype 0x80000002) at file offset ${String(offsets[1])} (${lastSibling}).`,
          ],
        },
      });
    },
  );

  it("refuses a subtype that no slice of the family has", () => {
    // Two same-family slices leave no single selector to offer.
    const ambiguous = select(
      [
        [CPU_ARM64, 0],
        [CPU_ARM64, 1],
      ],
      "arm64e",
    );
    expect(ambiguous.kind).toBe("architecture_not_present");
    expect(ambiguous.message).not.toMatch(/Select architecture/u);
    // A lone family slice is read by its family name, so the refusal names it.
    const lone: readonly (readonly [number, number])[] = [
      [CPU_X86_64, 3],
      [CPU_ARM64, 0],
    ];
    const refused = select(lone, "arm64e");
    expect(refused.kind).toBe("architecture_not_present");
    expect(refused.message).toMatch(/Select architecture arm64\.$/u);
    expect(select(lone, "arm64").offset).toBeDefined();
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
