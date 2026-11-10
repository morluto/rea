import { describe, expect, it } from "vitest";

import { selectPreferredMachoSlice } from "./MachoArchitectureSelection.js";

const CPU_ARM = 12;
const CPU_X86_64 = 0x01000007;
const CPU_ARM64 = 0x0100000c;
const slice = (index: number, cpuType: number, cpuSubtype: number) => ({
  index,
  cpuType,
  cpuSubtype,
});

describe("selectPreferredMachoSlice", () => {
  it("prefers listed subtypes over FAT table order", () => {
    for (const x86 of [
      [slice(0, CPU_X86_64, 8), slice(1, CPU_X86_64, 3)],
      [slice(0, CPU_X86_64, 3), slice(1, CPU_X86_64, 8)],
    ])
      expect(selectPreferredMachoSlice(x86, "x86_64")).toEqual({
        status: "selected",
        slice: x86.find(({ cpuSubtype }) => cpuSubtype === 3),
      });
    const arm64 = [slice(0, CPU_ARM64, 0x80000002), slice(1, CPU_ARM64, 0)];
    expect(selectPreferredMachoSlice(arm64, "arm64")).toEqual({
      status: "selected",
      slice: arm64[1],
    });
  });

  it("keeps FAT table order among subtypes with no listed preference", () => {
    // armv7s (11) before armv7 (9): the arm policy lists no subtype order.
    const arm = [slice(0, CPU_ARM, 11), slice(1, CPU_ARM, 9)];
    expect(selectPreferredMachoSlice(arm, "arm")).toEqual({
      status: "selected",
      slice: arm[0],
    });
  });

  it("refuses only a duplicated winning subtype and reports absent families", () => {
    // Duplicate arm64e slices do not matter once the arm64 slice wins.
    const layered = [
      slice(0, CPU_ARM64, 0x80000002),
      slice(1, CPU_ARM64, 0),
      slice(2, CPU_ARM64, 0x80000002),
    ];
    expect(selectPreferredMachoSlice(layered, "arm64")).toEqual({
      status: "selected",
      slice: layered[1],
    });
    // Capability bits do not distinguish a duplicate winner.
    expect(
      selectPreferredMachoSlice(
        [slice(0, CPU_ARM64, 0x80000002), slice(1, CPU_ARM64, 0x81000002)],
        "arm64",
      ),
    ).toEqual({ status: "ambiguous" });
    const duplicate = [slice(0, CPU_ARM64, 0), slice(1, CPU_ARM64, 0)];
    expect(selectPreferredMachoSlice(duplicate, "arm64")).toEqual({
      status: "ambiguous",
    });
    expect(selectPreferredMachoSlice(duplicate, "x86_64")).toEqual({
      status: "absent",
    });
    expect(selectPreferredMachoSlice(duplicate, "sparc")).toEqual({
      status: "absent",
    });
  });
});
