import { describe, expect, it } from "vitest";

import { rawLoadAtEntry } from "./rawBinary.fixture.js";
import type { BinaryTarget } from "./binaryTargetTypes.js";
import {
  binaryTargetIdentity,
  sameTargetIdentity,
  targetIdentityKey,
  urlTargetIdentitySchema,
  type FileTargetIdentity,
} from "./targetIdentity.js";

const SHA256 = "a".repeat(64);

describe("target identity key", () => {
  it("does not depend on member order", () => {
    const identity: FileTargetIdentity = {
      kind: "file",
      sha256: SHA256,
      format: "raw-binary",
      architecture: "arm",
      selection: { kind: "entry-point", entry_point: "0x8000000" },
    };
    const reordered: FileTargetIdentity = {
      selection: { entry_point: "0x8000000", kind: "entry-point" },
      architecture: "arm",
      format: "raw-binary",
      sha256: SHA256,
      kind: "file",
    };
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(identity));
    expect(targetIdentityKey(reordered)).toBe(targetIdentityKey(identity));
    expect(targetIdentityKey(identity)).toMatch(/^target_[0-9a-f]{64}$/u);
  });

  it("separates the same bytes under different selections", () => {
    const raw: BinaryTarget = {
      path: "/fixture/image.bin",
      sha256: SHA256,
      kind: "executable",
      format: "raw-binary",
      architecture: "arm",
      availableArchitectures: ["arm"],
      rawLoad: rawLoadAtEntry("0x08000000"),
    };
    const identity = binaryTargetIdentity(raw);
    expect(identity).toEqual({
      kind: "file",
      sha256: SHA256,
      format: "raw-binary",
      architecture: "arm",
      selection: { kind: "entry-point", entry_point: "0x8000000" },
    });
    const moved = binaryTargetIdentity({
      ...raw,
      rawLoad: rawLoadAtEntry("0x9000000"),
    });
    expect(sameTargetIdentity(identity, moved)).toBe(false);

    const flash: BinaryTarget = {
      path: "/fixture/flash.bin",
      sha256: SHA256,
      kind: "archive",
      format: "esp-flash-image",
      espFlash: { selected: true, flashOffset: 0, partitionTableOffset: null },
    };
    const flashIdentity = binaryTargetIdentity(flash);
    expect(flashIdentity.selection).toEqual({
      kind: "esp-flash",
      flash_offset: 0,
      partition_table_offset: null,
    });
    expect(
      sameTargetIdentity(
        flashIdentity,
        binaryTargetIdentity({
          ...flash,
          espFlash: { ...flash.espFlash, flashOffset: 0x1000 },
        }),
      ),
    ).toBe(false);
    // The path is display, not identity.
    expect(
      sameTargetIdentity(
        flashIdentity,
        binaryTargetIdentity({ ...flash, path: "/elsewhere" }),
      ),
    ).toBe(true);
  });

  it("separates the slices of one universal Mach-O container", () => {
    const universal: BinaryTarget = {
      path: "/fixture/universal",
      sha256: SHA256,
      kind: "executable",
      format: "mach-o-universal",
      architecture: "arm64",
      availableArchitectures: ["x86_64", "arm64"],
      universalSlice: { offset: 0x8000, size: 0x4000 },
      universalSlices: [
        { offset: 0x4000, size: 0x2000, cpuType: 0x0100_0007, cpuSubtype: 3 },
        { offset: 0x8000, size: 0x4000, cpuType: 0x0100_000c, cpuSubtype: 0 },
      ],
    };
    const arm64 = binaryTargetIdentity(universal);
    expect(arm64.selection).toEqual({
      kind: "universal-slice",
      offset: 0x8000,
      size: 0x4000,
      cpu_type: 0x0100_000c,
      cpu_subtype: 0,
    });
    const x86 = binaryTargetIdentity({
      ...universal,
      architecture: "x86_64",
      universalSlice: { offset: 0x4000, size: 0x2000 },
    });
    expect(sameTargetIdentity(arm64, x86)).toBe(false);
    // Without the admitted FAT table the slice range still selects, and the
    // CPU declaration stays explicitly unknown.
    const { universalSlices: _slices, ...unadmitted } = universal;
    expect(binaryTargetIdentity(unadmitted).selection).toEqual({
      kind: "universal-slice",
      offset: 0x8000,
      size: 0x4000,
      cpu_type: null,
      cpu_subtype: null,
    });
  });
});

describe("URL target identity", () => {
  const page = {
    kind: "url",
    url: "https://app.example.test/orders?id=1",
    origin: "https://app.example.test",
  } as const;

  it("separates two pages of one origin", () => {
    expect(urlTargetIdentitySchema.parse(page)).toEqual(page);
    expect(
      sameTargetIdentity(page, { ...page, url: "https://app.example.test/" }),
    ).toBe(false);
  });

  it.each([
    ["userinfo", { ...page, url: "https://user:pass@app.example.test/" }],
    ["a URL that does not parse", { ...page, url: "not a url" }],
    ["an origin the URL does not have", { ...page, origin: "https://x.test" }],
    ["a null origin for a tuple origin", { ...page, origin: null }],
  ])("refuses %s", (_case, identity) => {
    expect(urlTargetIdentitySchema.safeParse(identity).success).toBe(false);
  });
});
