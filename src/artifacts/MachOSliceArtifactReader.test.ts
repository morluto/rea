import { describe, expect, it } from "vitest";

import { MachOSliceArtifactReader } from "./MachOSliceArtifactReader.js";

describe("Mach-O slice reader with system lipo", () => {
  it.skipIf(process.platform !== "darwin")(
    "checks real /bin/ls lipo CPU symbols and ptrauth capabilities against the FAT table",
    async () => {
      const reader = new MachOSliceArtifactReader("/bin/ls");
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
      ).toEqual([
        [16384, 48112],
        [65536, 89088],
      ]);
    },
  );
});
