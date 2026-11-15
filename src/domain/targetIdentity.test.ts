import { describe, expect, it } from "vitest";

import { snapshotTarget, snapshotTargetIdentity } from "./analysisSnapshot.js";
import type { BinaryTarget } from "./binaryTargetTypes.js";
import {
  sameTargetIdentity,
  targetIdentityKey,
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
      entryPoint: "0x8000000",
      entryPointSource: "0x08000000",
    };
    const identity = snapshotTargetIdentity(snapshotTarget(raw));
    expect(identity).toEqual({
      kind: "file",
      sha256: SHA256,
      format: "raw-binary",
      architecture: "arm",
      selection: { kind: "entry-point", entry_point: "0x8000000" },
    });
    const moved = snapshotTargetIdentity(
      snapshotTarget({ ...raw, entryPoint: "0x9000000" }),
    );
    expect(sameTargetIdentity(identity, moved)).toBe(false);

    const flash: BinaryTarget = {
      path: "/fixture/flash.bin",
      sha256: SHA256,
      kind: "archive",
      format: "esp-flash-image",
      espFlash: { selected: true, flashOffset: 0, partitionTableOffset: null },
    };
    const flashIdentity = snapshotTargetIdentity(snapshotTarget(flash));
    expect(flashIdentity.selection).toEqual({
      kind: "esp-flash",
      flash_offset: 0,
      partition_table_offset: null,
    });
    expect(
      sameTargetIdentity(
        flashIdentity,
        snapshotTargetIdentity(
          snapshotTarget({
            ...flash,
            espFlash: { ...flash.espFlash, flashOffset: 0x1000 },
          }),
        ),
      ),
    ).toBe(false);
    // The path is display, not identity.
    expect(
      sameTargetIdentity(
        flashIdentity,
        snapshotTargetIdentity(
          snapshotTarget({ ...flash, path: "/elsewhere" }),
        ),
      ),
    ).toBe(true);
  });
});
