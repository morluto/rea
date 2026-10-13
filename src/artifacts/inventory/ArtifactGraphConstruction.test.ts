import { describe, expect, it } from "vitest";

import { CPU, fatImage, machoImage } from "../apple/MachoImage.fixture.js";
import { classifyArtifactContent } from "./ArtifactGraphConstruction.js";

const fat = (wide = false): Buffer =>
  Buffer.from(fatImage([{ cpu: CPU.arm64, bytes: machoImage({}) }], wide));

describe("bounded FAT inventory classification", () => {
  it("requires the complete table but not slice bytes in the retained prefix", () => {
    const bytes = fat();
    for (const length of [4, 7, 8, 27]) {
      expect(
        classifyArtifactContent(
          "native",
          bytes.subarray(0, length),
          bytes.length,
        ),
      ).toEqual({ kind: "unknown", format: "unknown" });
    }
    expect(
      classifyArtifactContent(
        "native.class",
        bytes.subarray(0, 28),
        bytes.length,
      ),
    ).toEqual({ kind: "executable", format: "mach-o-universal" });
  });

  it.each([
    ["empty table", (bytes: Buffer) => bytes.writeUInt32BE(0, 4)],
    ["slice overlapping table", (bytes: Buffer) => bytes.writeUInt32BE(0, 16)],
    ["empty slice", (bytes: Buffer) => bytes.writeUInt32BE(0, 20)],
    [
      "slice beyond file",
      (bytes: Buffer) => bytes.writeUInt32BE(bytes.length, 20),
    ],
    ["unaligned slice", (bytes: Buffer) => bytes.writeUInt32BE(4097, 16)],
    ["unsupported alignment", (bytes: Buffer) => bytes.writeUInt32BE(53, 24)],
  ] as const)("keeps %s unknown", (_label, mutate) => {
    const bytes = fat();
    mutate(bytes);
    expect(classifyArtifactContent("native", bytes)).toEqual({
      kind: "unknown",
      format: "unknown",
    });
  });

  it("does not infer Mach-O from an out-of-bounds architecture count", () => {
    const bytes = fat();
    bytes.writeUInt32BE(0xffffffff, 4);
    expect(classifyArtifactContent("native", bytes)).toEqual({
      kind: "resource",
      format: "file",
    });
  });

  it("does not lose unsafe FAT64 range values to number conversion", () => {
    const bytes = fat(true);
    bytes.writeBigUInt64BE(BigInt(Number.MAX_SAFE_INTEGER) + 1n, 16);
    expect(classifyArtifactContent("native", bytes)).toEqual({
      kind: "unknown",
      format: "unknown",
    });
  });

  it("requires valid ranges for every declared slice", () => {
    const bytes = Buffer.from(
      fatImage([
        { cpu: CPU.arm64, bytes: machoImage({}) },
        { cpu: CPU.x86_64, bytes: machoImage({ cpu: CPU.x86_64 }) },
      ]),
    );
    bytes.writeUInt32BE(bytes.length, 40);
    expect(classifyArtifactContent("native", bytes)).toEqual({
      kind: "unknown",
      format: "unknown",
    });
  });

  it("requires observed slice magic for an unknown CPU type", () => {
    const cpu = { type: 0x12345678, subtype: 0 };
    const bytes = Buffer.from(fatImage([{ cpu, bytes: machoImage({ cpu }) }]));
    expect(
      classifyArtifactContent("native", bytes.subarray(0, 28), bytes.length),
    ).toEqual({ kind: "unknown", format: "unknown" });
    expect(classifyArtifactContent("native", bytes)).toEqual({
      kind: "executable",
      format: "mach-o-universal",
    });
  });

  it.each([NaN, Infinity, -1, 8.5, Number.MAX_SAFE_INTEGER + 1, 27])(
    "keeps invalid or contradictory file size %s unknown",
    (size) => {
      const bytes = fat();
      expect(classifyArtifactContent("native", bytes, size)).toEqual({
        kind: "unknown",
        format: "unknown",
      });
    },
  );
});
