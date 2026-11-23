import { lstat, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseBinaryTarget } from "../../../src/application/BinaryTargetResolver.js";
import { hasTrailingZipArchive } from "../../../src/domain/zipPackageFormat.js";
import { artifactOccurrenceAt } from "../../fixtures/artifactEntryOrder.js";
import {
  classifyAndHashRoot,
  inventoryArtifact,
} from "../../fixtures/artifactInventory.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { zip64LeadingBytes } from "../../fixtures/zip64LeadingBytes.js";

describe("Zip64 archives after an unclaimed prefix", () => {
  it.each([
    { adjust: false, wideLocalOffset: false, extensionBytes: 0 },
    { adjust: true, wideLocalOffset: false, extensionBytes: 0 },
    { adjust: false, wideLocalOffset: true, extensionBytes: 0 },
    { adjust: true, wideLocalOffset: true, extensionBytes: 0 },
    { adjust: true, wideLocalOffset: true, extensionBytes: 8 },
  ])(
    "retains verified members for $adjust/$wideLocalOffset/$extensionBytes",
    async (options) => {
      const root = await createTestTempDirectory("rea-zip64-leading-");
      const { plain, bytes } = await zip64LeadingBytes(options);
      const control = join(root, "control.zip");
      const path = join(root, "installer.bin");
      await writeFile(control, plain);
      await writeFile(path, bytes);
      expect(
        (await classifyAndHashRoot(path, false, await lstat(path))).format,
      ).toBe("zip");
      expect(await parseBinaryTarget(path)).toMatchObject({
        ok: true,
        value: { format: "zip" },
      });
      const expected = await inventoryArtifact(control);
      const actual = await inventoryArtifact(path);
      for (const member of ["a.txt", "d/b.txt"]) {
        const baseline = artifactOccurrenceAt(expected, member);
        expect(baseline.hash_status).toBe("verified");
        expect(artifactOccurrenceAt(actual, member)).toMatchObject({
          hash_status: "verified",
          artifact_id: baseline.artifact_id,
        });
      }
      expect((await readFile(path)).equals(bytes)).toBe(true);
    },
  );

  it("reads the locator outside a maximum comment window and skips a false EOCD", async () => {
    const comment = Buffer.alloc(0xffff);
    comment.writeUInt32LE(0x06054b50, comment.length - 22);
    const { bytes } = await zip64LeadingBytes({ comment });
    const reads: number[] = [];
    expect(
      await hasTrailingZipArchive(bytes.length, async (at, length) => {
        expect(at).toBeGreaterThanOrEqual(0);
        reads.push(length);
        return bytes.subarray(at, at + length);
      }),
    ).toBe(true);
    expect(Math.max(...reads)).toBeLessThanOrEqual(22 + 0xffff);
    expect(reads).toContain(20);
  });
});

describe("Zip64 trailing directory refusals", () => {
  it.each([
    {
      field: "locator disk",
      change: (b: Buffer, r: number, l: number) => b.writeUInt32LE(1, l + 4),
    },
    {
      field: "locator volume count",
      change: (b: Buffer, r: number, l: number) => b.writeUInt32LE(2, l + 16),
    },
    {
      field: "directory disk",
      change: (b: Buffer, r: number) => b.writeUInt32LE(1, r + 20),
    },
    {
      field: "different per-disk count",
      change: (b: Buffer, r: number) => b.writeBigUInt64LE(1n, r + 24),
    },
    {
      field: "short record body",
      change: (b: Buffer, r: number) => b.writeBigUInt64LE(43n, r + 4),
    },
    {
      field: "record beyond its locator",
      change: (b: Buffer, r: number) => b.writeBigUInt64LE(45n, r + 4),
    },
    {
      field: "unrepresentable directory size",
      change: (b: Buffer, r: number) => b.writeBigUInt64LE(1n << 60n, r + 40),
    },
    {
      field: "unrepresentable directory offset",
      change: (b: Buffer, r: number) => b.writeBigUInt64LE(1n << 60n, r + 48),
    },
  ])(
    "refuses $field before routing the original file as ZIP",
    async ({ change }) => {
      const root = await createTestTempDirectory("rea-zip64-invalid-");
      const { bytes, record, locator } = await zip64LeadingBytes();
      change(bytes, record, locator);
      const path = join(root, "input.bin");
      await writeFile(path, bytes);
      expect(
        (await classifyAndHashRoot(path, false, await lstat(path))).format,
      ).toBe("file");
      expect((await parseBinaryTarget(path)).ok).toBe(false);
    },
  );

  it.each(["missing", "outside"] as const)(
    "refuses a %s wide local offset",
    async (shape) => {
      const { bytes, extra } = await zip64LeadingBytes({
        wideLocalOffset: true,
      });
      if (shape === "missing") bytes.writeUInt16LE(16, extra + 2);
      else bytes.writeBigUInt64LE(1n << 60n, extra + 20);
      expect(
        await hasTrailingZipArchive(bytes.length, async (at, length) => {
          expect(at).toBeGreaterThanOrEqual(0);
          expect(at + length).toBeLessThanOrEqual(bytes.length);
          return bytes.subarray(at, at + length);
        }),
      ).toBe(false);
    },
  );
});
