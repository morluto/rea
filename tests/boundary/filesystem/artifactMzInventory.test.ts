import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { classifyArtifactContent } from "../../../src/artifacts/inventory/ArtifactGraphConstruction.js";
import { ARTIFACT_CLASSIFICATION_PREFIX_BYTES } from "../../../src/artifacts/ArtifactHash.js";
import { scanCanonicalArtifactInventory } from "../../../src/artifacts/inventory/scanCanonical.js";
import { artifactInventoryResultSchema } from "../../../src/domain/artifactGraph.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

describe("MZ artifact classification", () => {
  it("rejects a Windows header pointer overlapping the DOS header", () => {
    expect(classifyArtifactContent("invalid.exe", peFixture(32))).toEqual({
      kind: "unknown",
      format: "unknown",
    });
  });

  it("distinguishes DOS, observed PE, malformed MZ and unavailable prefix evidence", () => {
    const dos = dosFixture();
    expect(classifyArtifactContent("LEGACY.EXE", dos)).toEqual({
      kind: "executable",
      format: "dos-mz",
    });
    expect(
      classifyArtifactContent("LEGACY.EXE", dos.subarray(0, 16), dos.length),
    ).toEqual({ kind: "unknown", format: "unknown" });
    expect(classifyArtifactContent("bad.exe", Buffer.from("MZbroken"))).toEqual(
      { kind: "unknown", format: "unknown" },
    );
    const distantPe = peFixture(ARTIFACT_CLASSIFICATION_PREFIX_BYTES + 64);
    expect(
      classifyArtifactContent(
        "NATIVE.EXE",
        distantPe.subarray(0, ARTIFACT_CLASSIFICATION_PREFIX_BYTES),
        distantPe.length,
      ),
    ).toEqual({ kind: "unknown", format: "unknown" });
    expect(classifyArtifactContent("NATIVE.EXE", distantPe).format).toBe("pe");
    const distantRelocations = dosWithDistantRelocations();
    expect(
      classifyArtifactContent("LEGACY.EXE", distantRelocations).format,
    ).toBe("dos-mz");
    expect(
      classifyArtifactContent(
        "LEGACY.EXE",
        distantRelocations.subarray(0, ARTIFACT_CLASSIFICATION_PREFIX_BYTES),
        distantRelocations.length,
      ).format,
    ).toBe("unknown");
  });

  it("keeps standalone and embedded DOS identities through inventory", async () => {
    const directory = await createTestTempDirectory("rea-mz-inventory-");
    const dosPath = join(directory, "LEGACY.EXE");
    const pePath = join(directory, "NATIVE.EXE");
    await writeFile(dosPath, dosFixture());
    await writeFile(pePath, peFixture(128));
    const standalone = artifactInventoryResultSchema.parse(
      await scanCanonicalArtifactInventory(dosPath),
    );
    expect(standalone.manifest.root_format).toBe("dos-mz");
    expect(standalone.nodes).toContainEqual(
      expect.objectContaining({ format: "dos-mz" }),
    );

    const tree = join(directory, "tree");
    await mkdir(tree);
    await writeFile(join(tree, "LEGACY.EXE"), dosFixture());
    await writeFile(join(tree, "NATIVE.EXE"), peFixture(128));
    const inventory = artifactInventoryResultSchema.parse(
      await scanCanonicalArtifactInventory(tree),
    );
    expect(inventory.nodes.map(({ format }) => format)).toEqual(
      expect.arrayContaining(["dos-mz", "pe"]),
    );
  });
});

const dosFixture = (): Buffer => {
  const bytes = Buffer.alloc(512);
  bytes.write("MZ", 0, "ascii");
  bytes.writeUInt16LE(1, 4);
  bytes.writeUInt16LE(2, 8);
  bytes.writeUInt16LE(28, 24);
  return bytes;
};

const peFixture = (offset: number): Buffer => {
  const bytes = Buffer.alloc(Math.max(512, offset + 24));
  bytes.write("MZ", 0, "ascii");
  bytes.writeUInt16LE(4, 8);
  bytes.writeUInt16LE(64, 24);
  bytes.writeUInt32LE(offset, 60);
  bytes.set([0x50, 0x45, 0, 0], offset);
  return bytes;
};

const dosWithDistantRelocations = (): Buffer => {
  const bytes = Buffer.alloc(16_384);
  bytes.write("MZ", 0, "ascii");
  bytes.writeUInt16LE(32, 4);
  bytes.writeUInt16LE(1, 6);
  bytes.writeUInt16LE(768, 8);
  bytes.writeUInt16LE(ARTIFACT_CLASSIFICATION_PREFIX_BYTES + 2, 24);
  return bytes;
};
