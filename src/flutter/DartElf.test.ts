import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { readElfSymbol, readSnapshotHeader } from "./DartElf.js";

const GALLERY_LIBAPP =
  "/tmp/opencode/flutter-target/extracted/lib/arm64-v8a/libapp.so";

const galleryBytes = (): Buffer | null => {
  try {
    return readFileSync(GALLERY_LIBAPP);
  } catch {
    return null;
  }
};

describe("readElfSymbol", () => {
  it.skipIf(galleryBytes() === null)(
    "locates the real snapshot symbols in Flutter Gallery's arm64 image",
    () => {
      const bytes = galleryBytes()!;
      const isolateData = readElfSymbol(bytes, "_kDartIsolateSnapshotData");
      if ("failure" in isolateData) throw new Error(isolateData.failure.reason);
      expect(isolateData.symbol.offset).toBe(0x9f0000);
      expect(isolateData.symbol.size).toBe(14263200);
      const buildId = readElfSymbol(bytes, "_kDartSnapshotBuildId");
      if ("failure" in buildId) throw new Error(buildId.failure.reason);
      expect(buildId.symbol.offset).toBe(0x4000);
    },
  );

  it("refuses a non-ELF image instead of guessing", () => {
    const result = readElfSymbol(Buffer.from("not an elf at all"), "x");
    expect("failure" in result && result.failure.reason).toBe(
      "not an ELF image",
    );
  });

  it("refuses an unknown symbol", () => {
    const result = readElfSymbol(
      Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, ...Array(64).fill(0)]),
      "_kDartAbsent",
    );
    expect("failure" in result).toBe(true);
  });
});

describe("readSnapshotHeader", () => {
  it.skipIf(galleryBytes() === null)(
    "reads the real isolate data header",
    () => {
      const bytes = galleryBytes()!;
      const header = readSnapshotHeader(bytes, 0x9f0000);
      expect(header.magicValid).toBe(true);
      expect(header.kind).toBe(3);
      expect(header.headerLength).toBeGreaterThan(1_000_000);
    },
  );

  it("reports nulls for sections without the data magic", () => {
    const header = readSnapshotHeader(Buffer.from([0, 0, 0, 0, 0, 0, 0, 0]), 0);
    expect(header).toEqual({
      magicValid: false,
      kind: null,
      headerLength: null,
    });
  });
});
