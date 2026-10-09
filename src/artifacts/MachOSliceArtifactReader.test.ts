import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { MachOSliceArtifactReader } from "./MachOSliceArtifactReader.js";

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
  it.skipIf(process.platform !== "darwin")(
    "checks real /bin/ls lipo CPU symbols and ptrauth capabilities against the FAT table",
    async () => {
      const reader = new MachOSliceArtifactReader("/bin/ls", {});
      const entries = [];
      for await (const entry of reader.entries()) entries.push(entry);
      expect(entries.map(({ path }) => path)).toEqual([
        "slices/x86_64",
        "slices/arm64e",
      ]);
      expect(
        entries.map(({ byteOffset, declaredSize }) => [
          byteOffset,
          declaredSize,
        ]),
      ).toEqual(await fatSlices("/bin/ls"));
    },
  );
});
