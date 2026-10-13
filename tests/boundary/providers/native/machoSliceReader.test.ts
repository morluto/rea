import { readFile } from "node:fs/promises";

import { describe, expect, it, onTestFinished } from "vitest";

import { MachOSliceArtifactReader } from "../../../../src/artifacts/MachOSliceArtifactReader.js";
import { XcrunCommandRunner } from "../../../../src/native/CommandRunner.js";
import { DarwinProcessOwnershipInspectionError } from "../../../../src/process/DarwinProcessRunTokenReader.js";

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
    "checks real /bin/ls slice ranges against its FAT table",
    async () => {
      const reader = new MachOSliceArtifactReader("/bin/ls", {});
      onTestFinished(() => reader.close());
      const entries = [];
      for await (const entry of reader.entries()) entries.push(entry);
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
});
