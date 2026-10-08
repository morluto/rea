import { describe, expect, it } from "vitest";

import {
  CPU,
  fatImage,
  machoImage,
} from "../artifacts/apple/MachoImage.fixture.js";
import { parseMachoLayout } from "./AppleMachoSelection.js";

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
