import { describe, expect, it } from "vitest";

import {
  CPU,
  fatImage,
  machoImage,
} from "../../artifacts/apple/MachoImage.fixture.js";
import { selectNativeImage } from "./MachoSliceSelection.js";

/**
 * Stock macOS binaries such as /usr/bin/file ship x86_64 + arm64 + arm64e
 * slices. Requesting arm64 must resolve to the arm64 slice, the same slice
 * inspect-macho picks through its shared preference order, instead of
 * refusing because several slices share the arm64 CPU type.
 */
const threeSliceFile = () =>
  Buffer.from(
    fatImage([
      { cpu: CPU.x86_64, bytes: machoImage({ cpu: CPU.x86_64 }) },
      { cpu: CPU.arm64, bytes: machoImage({ cpu: CPU.arm64 }) },
      { cpu: CPU.arm64e, bytes: machoImage({ cpu: CPU.arm64e }) },
    ]),
  );

describe("selectNativeImage with several slices of one CPU type", () => {
  it("resolves arm64 to the arm64 slice of an x86_64 + arm64 + arm64e file", () => {
    const bytes = threeSliceFile();
    const selected = selectNativeImage(bytes, "arm64");
    if (!selected.ok) throw new Error(selected.error.message);
    // fatImage places the x86_64 slice at 4096 and the arm64 slice at 8192.
    expect(selected.value.fileOffset).toBe(8192);
    expect(selected.value.selection).toMatchObject({
      offset: 8192,
      cpu_type: CPU.arm64.type,
      cpu_subtype: CPU.arm64.subtype,
    });
    expect(selected.value.bytes).toEqual(
      bytes.subarray(8192, 8192 + machoImage({ cpu: CPU.arm64 }).length),
    );
  });

  it("prefers the arm64 slice even when arm64e comes first in the FAT table", () => {
    const bytes = Buffer.from(
      fatImage([
        { cpu: CPU.arm64e, bytes: machoImage({ cpu: CPU.arm64e }) },
        { cpu: CPU.arm64, bytes: machoImage({ cpu: CPU.arm64 }) },
      ]),
    );
    const selected = selectNativeImage(bytes, "arm64");
    if (!selected.ok) throw new Error(selected.error.message);
    expect(selected.value.fileOffset).toBe(8192);
    expect(selected.value.selection).toMatchObject({
      cpu_subtype: CPU.arm64.subtype,
    });
  });

  it("still resolves the single-slice architectures of the same file", () => {
    const bytes = threeSliceFile();
    const x86 = selectNativeImage(bytes, "x86_64");
    if (!x86.ok) throw new Error(x86.error.message);
    expect(x86.value.fileOffset).toBe(4096);
    expect(x86.value.selection).toMatchObject({
      cpu_type: CPU.x86_64.type,
      cpu_subtype: CPU.x86_64.subtype,
    });
  });

  it("still refuses slices that share a base subtype", () => {
    const bytes = Buffer.from(
      fatImage([
        { cpu: CPU.arm64, bytes: machoImage({ cpu: CPU.arm64 }) },
        { cpu: CPU.arm64, bytes: machoImage({ cpu: CPU.arm64 }) },
      ]),
    );
    const selected = selectNativeImage(bytes, "arm64");
    expect(selected.ok).toBe(false);
    if (selected.ok) throw new Error("Expected the duplicate slices to refuse");
    expect(selected.error).toEqual({
      kind: "architecture",
      message:
        "Universal Mach-O holds several arm64 slices (arm64 (subtype 0x0), arm64 (subtype 0x0)); no slice was selected.",
    });
  });

  it("still reports a missing architecture instead of selecting a slice", () => {
    const bytes = threeSliceFile();
    const selected = selectNativeImage(bytes, "x86");
    expect(selected.ok).toBe(false);
    if (selected.ok) throw new Error("Expected the missing architecture to refuse");
    expect(selected.error).toEqual({
      kind: "architecture",
      message:
        "Universal Mach-O holds x86_64 (subtype 0x3), arm64 (subtype 0x0), arm64 (subtype 0x80000002), not x86.",
    });
  });
});
