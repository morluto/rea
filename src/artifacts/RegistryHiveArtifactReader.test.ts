import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { REGF_BASE_BLOCK_BYTES } from "../domain/windows/registryHive.js";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { scanCanonicalArtifactInventory } from "../../tests/fixtures/artifactInventory.js";

/** A 4 KiB base block followed by one hive bin holding two cells. */
const hiveBytes = (): Buffer => {
  const binSize = 4096;
  const hive = Buffer.alloc(REGF_BASE_BLOCK_BYTES + binSize);
  hive.write("regf", 0, "latin1");
  hive.writeUInt32LE(4, 4);
  hive.writeUInt32LE(4, 8);
  hive.writeUInt32LE(1, 20);
  hive.writeUInt32LE(5, 24);
  hive.writeUInt32LE(0x20, 36);
  hive.writeUInt32LE(binSize, 40);
  let xor = 0;
  for (let offset = 0; offset < 508; offset += 4)
    xor ^= hive.readUInt32LE(offset);
  hive.writeUInt32LE(xor >>> 0, 508);
  const bin = REGF_BASE_BLOCK_BYTES;
  hive.write("hbin", bin, "latin1");
  hive.writeUInt32LE(0, bin + 4);
  hive.writeUInt32LE(binSize, bin + 8);
  hive.writeInt32LE(-32, bin + 32);
  hive.writeInt32LE(-48, bin + 64);
  return hive;
};

const writeHive = async (name: string): Promise<string> => {
  const directory = await createTestTempDirectory("rea-regf-hive-");
  const path = join(directory, name);
  await writeFile(path, hiveBytes());
  return path;
};

it("reports a hive's base block and cell counts as the root occurrence", async () => {
  const inventory = await scanCanonicalArtifactInventory(
    await writeHive("SYSTEM"),
  );
  expect(inventory.manifest.root_format).toBe("regf-hive");
  expect(inventory.coverage.status).toBe("complete");
  // A hive declares no members, so the root is its whole inventory.
  expect(inventory.occurrences.map((row) => row.logical_path)).toEqual(["."]);
  expect(inventory.occurrences[0]).toMatchObject({
    artifact_format: "regf-hive",
    format_metadata: {
      kind: "regf-hive",
      major_version: 1,
      minor_version: 5,
      primary_sequence: 4,
      secondary_sequence: 4,
      dirty: false,
      checksum_matches: true,
      hive_bin_count: 1,
      cell_count: 2,
      allocated_cell_count: 2,
    },
  });
});

it("names a dirty hive's sequence mismatch in the limitations", async () => {
  const directory = await createTestTempDirectory("rea-regf-hive-dirty-");
  const path = join(directory, "NTUSER.DAT");
  const hive = hiveBytes();
  hive.writeUInt32LE(4, 4);
  hive.writeUInt32LE(9, 8);
  // The base-block checksum covers the sequence pair, so recompute it.
  hive.writeUInt32LE(0, 508);
  let xor = 0;
  for (let offset = 0; offset < 508; offset += 4)
    xor ^= hive.readUInt32LE(offset);
  hive.writeUInt32LE(xor >>> 0, 508);
  await writeFile(path, hive);

  const inventory = await scanCanonicalArtifactInventory(path);
  expect(inventory.manifest.root_format).toBe("regf-hive");
  expect(inventory.limitations).toContainEqual(
    expect.stringMatching(/not cleanly closed/iu),
  );
});
