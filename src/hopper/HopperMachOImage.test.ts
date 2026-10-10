import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { resolveHopperMachOImage } from "./HopperMachOImage.js";

it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "reports a FAT64 source that became unreadable as a host read denial",
  async () => {
    const directory = await createTestTempDirectory("rea-hopper-fat64-");
    const path = join(directory, "universal");
    await writeFile(path, Buffer.alloc(64));
    await chmod(path, 0);
    try {
      const result = await resolveHopperMachOImage({
        path,
        sha256: "0".repeat(64),
        kind: "executable",
        format: "mach-o",
        architecture: "arm64",
        availableArchitectures: ["arm64"],
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toMatchObject({ systemCode: "EACCES" });
      expect(projectAnalysisError(result.error)).toMatchObject({
        code: "access_denied",
        details: { path, system_code: "EACCES" },
      });
    } finally {
      await chmod(path, 0o600);
    }
  },
);

it("rejects an ELF target before attempting FAT64 source preparation", async () => {
  const directory = await createTestTempDirectory("rea-hopper-mips-boundary-");
  // No file is created: format validation must precede any filesystem lookup.
  const path = join(directory, "mips.elf");
  const result = await resolveHopperMachOImage({
    path,
    sha256: "0".repeat(64),
    kind: "executable",
    format: "elf",
    architecture: "mips",
    availableArchitectures: ["mips"],
    mips: { elfClass: 32, byteOrder: "little", type: 2, flags: 0x70001001 },
  });
  if (result.ok)
    throw new Error("An ELF target entered Mach-O image preparation");
  expect(result.error).toMatchObject({
    _tag: "BinaryTargetError",
    path,
    reason: "Hopper FAT64 image preparation requires a Mach-O target",
  });
});
