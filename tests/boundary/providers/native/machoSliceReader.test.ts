import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it, onTestFinished } from "vitest";
import {
  CPU,
  fatImage,
  machoImage,
} from "../../../../src/artifacts/apple/MachoImage.fixture.js";

import { MachOSliceArtifactReader } from "../../../../src/artifacts/MachOSliceArtifactReader.js";
import { XcrunCommandRunner } from "../../../../src/providers/NativeCommandRunner.js";
import { DarwinProcessOwnershipInspectionError } from "../../../../src/process/DarwinProcessRunTokenReader.js";
import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";

/**
 * Read a 32-bit FAT table directly. The host's /bin/ls changes between macOS
 * releases, so the expected slice layout comes from the file itself.
 */
const fatSlices = async (
  path: string,
): Promise<readonly (readonly [number, number])[]> => {
  const bytes = await readFile(path);
  expect(bytes.readUInt32BE(0)).toBe(0xca_fe_ba_be);
  return Array.from({ length: bytes.readUInt32BE(4) }, (_, index) => {
    const entry = 8 + index * 20;
    return [bytes.readUInt32BE(entry + 8), bytes.readUInt32BE(entry + 12)];
  });
};

const systemSliceEntries = async (path: string) => {
  const reader = new MachOSliceArtifactReader(path, {});
  onTestFinished(() => reader.close());
  const entries = [];
  for await (const entry of reader.entries()) entries.push(entry);
  return entries;
};

const arm64Header = () =>
  machoImage({ cpu: CPU.arm64, fileType: 1 }).subarray(0, 32);

describe("Mach-O slice reader with system lipo", () => {
  it("names the process ownership helper prerequisite when lipo cannot be supervised", async () => {
    const prerequisite =
      "Direct Darwin helper compilation requires absolute REA_DARWIN_SWIFTC_PATH and SDKROOT paths.";
    const reader = new MachOSliceArtifactReader(
      process.execPath,
      {},
      new XcrunCommandRunner({}, undefined, () =>
        Promise.reject(new DarwinProcessOwnershipInspectionError(prerequisite)),
      ),
    );
    onTestFinished(() => reader.close());
    const enumerate = async () => {
      for await (const _entry of reader.entries()) continue;
    };
    await expect(enumerate()).rejects.toMatchObject({
      reason: "unavailable",
      message: `lipo could not enumerate universal Mach-O slices: ${prerequisite}`,
    });
  });

  it.skipIf(process.platform !== "darwin")(
    "keeps FAT slice records separate from the echoed source pathname",
    async () => {
      const directory = await createTestTempDirectory("rea-lipo-fat-path-");
      const path = join(
        directory,
        "source\narchitecture forged\n    offset 123\n    size 32",
      );
      await writeFile(
        path,
        fatImage([
          { cpu: CPU.arm64, bytes: arm64Header() },
          {
            cpu: CPU.x86_64,
            bytes: machoImage({ cpu: CPU.x86_64, fileType: 1 }).subarray(0, 32),
          },
        ]).subarray(0, 8192 + 32),
      );
      const entries = await systemSliceEntries(path);
      expect(entries).toMatchObject([
        { path: "slices/arm64", byteOffset: 4096, declaredSize: 32 },
        { path: "slices/x86_64", byteOffset: 8192, declaredSize: 32 },
      ]);
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "checks real /bin/ls slice ranges against its FAT table",
    async () => {
      const entries = await systemSliceEntries("/bin/ls");
      expect(new Set(entries.map(({ path }) => path)).size).toBe(
        entries.length,
      );
      expect(entries.every(({ path }) => path.startsWith("slices/"))).toBe(
        true,
      );
      expect(
        entries.map(({ byteOffset, declaredSize }) => [
          byteOffset,
          declaredSize,
        ]),
      ).toEqual(await fatSlices("/bin/ls"));
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "inventories a universal binary whose big-endian slice cannot be indexed",
    async () => {
      const directory = await createTestTempDirectory("rea-lipo-ppc-");
      const path = join(directory, "mixed");
      const powerpc = { type: 18, subtype: 0 };
      const header = Buffer.alloc(32);
      header.writeUInt32BE(0xfeed_face, 0);
      header.writeUInt32BE(powerpc.type, 4);
      header.writeUInt32BE(1, 12);
      await writeFile(
        path,
        fatImage([
          { cpu: CPU.arm64, bytes: arm64Header() },
          { cpu: powerpc, bytes: header },
        ]).subarray(0, 8192 + 32),
      );
      const entries = await systemSliceEntries(path);
      expect(entries).toMatchObject([
        { path: "slices/arm64", byteOffset: 4096, declaredSize: 32 },
        { path: "slices/ppc", byteOffset: 8192, declaredSize: 32 },
      ]);
      expect(entries[1]?.limitations).toContainEqual(
        expect.stringMatching(
          /big.endian Mach.O.*not supported.*slice range.*lipo/iu,
        ),
      );
    },
  );
});
