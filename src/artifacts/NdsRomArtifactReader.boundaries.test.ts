import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  materializeArtifactInventory,
  scanCanonicalArtifactInventory,
} from "../../tests/fixtures/artifactInventory.js";
import {
  createTestTempDirectory,
  createTestTempFile,
} from "../../tests/fixtures/temporaryDirectory.js";
import {
  SafeOutputTree,
  type ArtifactEntry,
  type ArtifactReaderTraversal,
} from "../resources/index.js";
import {
  NDS_FIXTURE,
  NDS_FIXTURE_FILES,
  ndsRomFixture,
  resealNdsHeader,
} from "../domain/ndsRom.fixture.js";
import { NdsRomArtifactReader } from "./NdsRomArtifactReader.js";

const read = async (bytes: Buffer) => {
  const reader = new NdsRomArtifactReader(
    await createTestTempFile("rea-nds-boundary-", "game.nds", bytes),
  );
  const coverage: ArtifactReaderTraversal[] = [];
  const entries: ArtifactEntry[] = [];
  try {
    for await (const entry of reader.entries(undefined, {
      onCoverage: (value) => coverage.push(value),
    }))
      entries.push(entry);
    return {
      entries,
      coverage: coverage[0],
      metadata: reader.formatMetadata(),
    };
  } finally {
    await reader.close();
  }
};

describe("Nintendo DS ROM boundaries", () => {
  it("refuses a header cut short as truncated", async () => {
    await expect(
      read(ndsRomFixture().subarray(0, 0x100)),
    ).rejects.toMatchObject({
      parseFailure: { kind: "truncated", format: "nds" },
    });
  });

  it("omits an ARM9 binary that ends past the file", async () => {
    const rom = ndsRomFixture();
    rom.writeUInt32LE(0x10_0000, 0x2c);
    const result = await read(resealNdsHeader(rom));
    expect(result.entries.map((entry) => entry.path)).not.toContain("arm9.bin");
    expect(result.coverage).toMatchObject({
      status: "unknown",
      limitations: [expect.stringContaining("DS ARM9 binary")],
    });
  });

  it("does not read a FAT that starts past the file", async () => {
    const rom = ndsRomFixture();
    rom.writeUInt32LE(0x10_0000, 0x48);
    const result = await read(resealNdsHeader(rom));
    expect(result.metadata?.file_count).toBe(0);
    expect(result.entries.map((entry) => entry.path)).toEqual([
      "arm9.bin",
      "arm7.bin",
    ]);
    expect(result.coverage?.status).toBe("unknown");
    expect(result.coverage?.limitations).toContainEqual(
      expect.stringContaining("DS FAT at 1048576 starts past"),
    );
  });

  it("skips an empty overlay table declared past the file", async () => {
    const rom = ndsRomFixture();
    rom.writeUInt32LE(0xffff_ffff, 0x58);
    rom.writeUInt32LE(0, 0x5c);
    const result = await read(resealNdsHeader(rom));
    expect(result.coverage).toMatchObject({
      status: "complete",
      limitations: [],
    });
    expect(result.metadata?.arm7_overlay_count).toBe(0);
    expect(result.entries.map((entry) => entry.path)).toContain(
      "data/data/a.bin",
    );
  });

  it("reads only the part of an FNT that fits in the file", async () => {
    const rom = ndsRomFixture();
    rom.writeUInt32LE(0xffff_ffff, 0x44);
    const result = await read(resealNdsHeader(rom));
    // The tree still resolves; the oversized declaration is reported.
    expect(result.entries.map((entry) => entry.path)).toContain(
      "data/data/a.bin",
    );
    expect(result.coverage?.limitations).toContainEqual(
      expect.stringContaining("DS FNT declares 4294967295 bytes"),
    );
  });

  it("reports an overlay whose file ID has no FAT entry", async () => {
    const rom = ndsRomFixture();
    rom.writeUInt32LE(9, NDS_FIXTURE.arm9OverlayTable + 24);
    const result = await read(rom);
    expect(result.coverage?.limitations).toContainEqual(
      expect.stringContaining("DS ARM9 overlay 0 names file 9"),
    );
    expect(result.entries.map((entry) => entry.path)).toContain(
      "fat/00000.bin",
    );
  });

  it("refuses to walk a subdirectory ID below the directory range", async () => {
    const rom = ndsRomFixture();
    const rootSub = NDS_FIXTURE.fnt + rom.readUInt32LE(NDS_FIXTURE.fnt);
    // readme.txt entry (11 bytes), then the "data" entry's ID field.
    rom.writeUInt16LE(0x0002, rootSub + 11 + 1 + 4);
    const result = await read(rom);
    expect(result.coverage?.limitations).toContainEqual(
      expect.stringContaining("which is not a directory ID"),
    );
    expect(result.metadata?.directory_count).toBe(1);
  });

  it.each([
    ["a:b", "CON"],
    ["a:b", "a*b"],
  ] as const)(
    "lists Windows-unsafe FNT names (%j, %j) under their FAT-ID fallbacks and extracts them",
    async (rootName, nestedName) => {
      const rom = ndsRomFixture();
      const fnt = NDS_FIXTURE.fnt;
      const rootSub = 16;
      const root = Buffer.concat([
        Buffer.from([rootName.length]),
        Buffer.from(rootName, "latin1"),
        Buffer.from([0x80 | 4]),
        Buffer.from("data", "latin1"),
        Buffer.from([0x01, 0xf0, 0]),
      ]);
      const dataSub = rootSub + root.length;
      const data = Buffer.concat([
        Buffer.from([nestedName.length]),
        Buffer.from(nestedName, "latin1"),
        Buffer.from([0]),
      ]);
      rom.fill(0, fnt + rootSub, fnt + NDS_FIXTURE.fntSize);
      rom.writeUInt32LE(dataSub, fnt + 8);
      root.copy(rom, fnt + rootSub);
      data.copy(rom, fnt + dataSub);

      const path = await createTestTempFile(
        "rea-nds-windows-names-",
        "game.nds",
        rom,
      );
      const snapshot = await scanCanonicalArtifactInventory(path);
      expect(snapshot.coverage.status).toBe("unknown");
      expect(snapshot.limitations).toContainEqual(
        expect.stringContaining(
          `DS FNT name ${JSON.stringify(rootName)} in directory 61440 is not a portable path segment`,
        ),
      );
      expect(snapshot.limitations).toContainEqual(
        expect.stringContaining(
          `DS FNT name ${JSON.stringify(nestedName)} in directory 61441 is not a portable path segment`,
        ),
      );
      const logicalPaths = snapshot.occurrences.map((row) => row.logical_path);
      expect(logicalPaths).not.toContain(`data/${rootName}`);
      expect(logicalPaths).not.toContain(`data/data/${nestedName}`);
      const selected = snapshot.occurrences
        .filter((row) =>
          ["fat/00001.bin", "fat/00002.bin"].includes(row.logical_path),
        )
        .map((row) => row.occurrence_id);
      expect(selected).toHaveLength(2);

      const output = join(
        await createTestTempDirectory("rea-nds-win-out-"),
        "out",
      );
      const extracted = await materializeArtifactInventory(
        {
          inputPath: path,
          inputFormat: "nds",
          outputRoot: output,
          occurrenceIds: selected,
          environment: process.env,
          integrityPolicy: "fail",
        },
        path,
        snapshot,
      );
      expect(
        extracted.artifacts.map((artifact) => artifact.relative_path).sort(),
      ).toEqual(["fat/00001.bin", "fat/00002.bin"]);
      expect(
        (await readFile(join(output, "fat", "00001.bin"))).equals(
          NDS_FIXTURE_FILES.readme,
        ),
      ).toBe(true);
      expect(
        (await readFile(join(output, "fat", "00002.bin"))).equals(
          NDS_FIXTURE_FILES.asset,
        ),
      ).toBe(true);

      // Confirm the shared Windows destination writer accepts every fallback path.
      const winOutput = join(
        await createTestTempDirectory("rea-nds-win32-tree-"),
        "out",
      );
      const tree = await SafeOutputTree.create(winOutput, "win32");
      try {
        for (const [relativePath, bytes] of [
          ["fat/00001.bin", NDS_FIXTURE_FILES.readme],
          ["fat/00002.bin", NDS_FIXTURE_FILES.asset],
        ] as const) {
          const written = await tree.write(relativePath, Readable.from(bytes), {
            bytes: bytes.length,
          });
          expect(written.relativePath).toBe(relativePath);
        }
        await tree.commit();
      } finally {
        if (!tree.published) await tree.rollback();
      }
    },
  );
});
