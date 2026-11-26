import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { buffer } from "node:stream/consumers";

import { describe, expect, it } from "vitest";

import {
  inventoryArtifact,
  materializeArtifactInventory,
  scanCanonicalArtifactInventory,
} from "../../tests/fixtures/artifactInventory.js";
import {
  createTestTempDirectory,
  createTestTempFile,
} from "../../tests/fixtures/temporaryDirectory.js";
import { parseBinaryTarget } from "../application/BinaryTargetResolver.js";
import type {
  ArtifactEntry,
  ArtifactReaderTraversal,
} from "../resources/index.js";
import { ARTIFACT_COMPARISON_EXAMPLE } from "../contracts/artifactComparisonExample.js";
import { compareArtifacts } from "../domain/artifactComparison.js";
import { artifactInventoryResultSchema } from "../domain/artifactGraph.js";
import { createEvidence } from "../domain/evidence.js";
import {
  NDS_FIXTURE,
  NDS_FIXTURE_FILES,
  ndsRomFixture,
  resealNdsHeader,
} from "../domain/ndsRom.fixture.js";
import { NdsRomArtifactReader } from "./NdsRomArtifactReader.js";

const write = (bytes: Buffer, name = "game.nds"): Promise<string> =>
  createTestTempFile("rea-nds-", name, bytes);

const read = async (bytes: Buffer) => {
  const reader = new NdsRomArtifactReader(await write(bytes));
  const coverage: ArtifactReaderTraversal[] = [];
  const entries: ArtifactEntry[] = [];
  try {
    for await (const entry of reader.entries(undefined, {
      onCoverage: (value) => coverage.push(value),
    }))
      entries.push(entry);
    const contents = new Map<string, Buffer>();
    for (const entry of entries)
      contents.set(entry.path, await buffer(await reader.open(entry)));
    return { entries, coverage, contents, metadata: reader.formatMetadata() };
  } finally {
    await reader.close();
  }
};

describe("Nintendo DS ROM reader", () => {
  it("lists CPU binaries, overlays and filesystem files with their bytes", async () => {
    const result = await read(ndsRomFixture());
    expect(result.coverage).toEqual([{ status: "complete", limitations: [] }]);
    expect(result.metadata).toMatchObject({
      kind: "nds",
      game_code: "REAE",
      file_count: 3,
      directory_count: 2,
      arm9_overlay_count: 1,
    });
    expect(result.entries.map((entry) => entry.path)).toEqual([
      "arm9.bin",
      "arm7.bin",
      "overlays/arm9/overlay_0000.bin",
      "data/readme.txt",
      "data/data/a.bin",
    ]);
    expect(result.entries[0]?.formatMetadata).toEqual({
      kind: "nds-entry",
      role: "arm9",
      file_id: null,
      ram_address: 0x0200_0000,
      entry_address: 0x0200_0800,
      overlay: null,
    });
    expect(
      result.contents.get("arm9.bin")?.equals(Buffer.alloc(0x100, 0x99)),
    ).toBe(true);
    expect(
      result.contents.get("data/readme.txt")?.equals(NDS_FIXTURE_FILES.readme),
    ).toBe(true);
    expect(
      result.contents
        .get("overlays/arm9/overlay_0000.bin")
        ?.equals(NDS_FIXTURE_FILES.overlay),
    ).toBe(true);
  });

  it("classifies a DS ROM as an archive target by its header", async () => {
    // An unrelated extension: detection reads the header, not the name.
    const path = await write(ndsRomFixture(), "rom.bin");
    expect(await parseBinaryTarget(path)).toMatchObject({
      ok: true,
      value: { kind: "archive", format: "nds" },
    });
  });

  it("inventories a DS ROM root with hashed entries", async () => {
    const graph = await inventoryArtifact(await write(ndsRomFixture()));
    expect(graph.manifest.root_format).toBe("nds");
    expect(graph.coverage.status).toBe("complete");
    expect(
      graph.occurrences.find((row) => row.logical_path === "data/data/a.bin"),
    ).toMatchObject({
      hash_status: "verified",
      format_metadata: { kind: "nds-entry", role: "file", file_id: 2 },
    });
  });

  it("extracts ARM9, ARM7 and a selected file", async () => {
    const path = await write(ndsRomFixture());
    const snapshot = await scanCanonicalArtifactInventory(path);
    const selected = snapshot.occurrences
      .filter((row) =>
        ["arm9.bin", "arm7.bin", "data/readme.txt"].includes(row.logical_path),
      )
      .map((row) => row.occurrence_id);
    expect(selected).toHaveLength(3);
    const output = join(await createTestTempDirectory("rea-nds-out-"), "out");
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
    ).toEqual(["arm7.bin", "arm9.bin", "data/readme.txt"]);
    expect(
      (await readFile(join(output, "arm7.bin"))).equals(
        Buffer.alloc(0x80, 0x77),
      ),
    ).toBe(true);
    expect(
      (await readFile(join(output, "data", "readme.txt"))).equals(
        NDS_FIXTURE_FILES.readme,
      ),
    ).toBe(true);
  });

  it("compares ARM9/overlay load declarations while ignoring layout-only FAT file IDs", async () => {
    const leftRom = ndsRomFixture();
    const rightRom = ndsRomFixture();
    // Change ARM9 entry_address and overlay RAM address without changing member bytes.
    rightRom.writeUInt32LE(NDS_FIXTURE.arm9.entry + 0x10, 0x24);
    rightRom.writeUInt32LE(0x0210_1000, NDS_FIXTURE.arm9OverlayTable + 4);
    resealNdsHeader(rightRom);

    // Swap FAT IDs 1 (readme.txt) and 2 (data/a.bin) in a third ROM while keeping
    // the same logical paths and bytes.
    const repackedRom = ndsRomFixture();
    const fat1Start = repackedRom.readUInt32LE(NDS_FIXTURE.fat + 8);
    const fat1End = repackedRom.readUInt32LE(NDS_FIXTURE.fat + 12);
    const fat2Start = repackedRom.readUInt32LE(NDS_FIXTURE.fat + 16);
    const fat2End = repackedRom.readUInt32LE(NDS_FIXTURE.fat + 20);
    repackedRom.writeUInt32LE(fat2Start, NDS_FIXTURE.fat + 8);
    repackedRom.writeUInt32LE(fat2End, NDS_FIXTURE.fat + 12);
    repackedRom.writeUInt32LE(fat1Start, NDS_FIXTURE.fat + 16);
    repackedRom.writeUInt32LE(fat1End, NDS_FIXTURE.fat + 20);
    // Root first-file ID -> 2 (readme.txt), data subdir first-file ID -> 1 (data/a.bin).
    repackedRom.writeUInt16LE(2, NDS_FIXTURE.fnt + 4);
    repackedRom.writeUInt16LE(1, NDS_FIXTURE.fnt + 12);

    const evidenceFor = async (rom: Buffer, name: string) => {
      const path = await write(rom, name);
      const inventory = artifactInventoryResultSchema.parse(
        await scanCanonicalArtifactInventory(path),
      );
      return createEvidence(
        {
          path: name,
          sha256: inventory.manifest.root_sha256,
          format: "nds",
        },
        ARTIFACT_COMPARISON_EXAMPLE.left.provider,
        {
          operation: "inventory_artifact",
          parameters: {},
          result: inventory,
          confidence: "observed",
          authority: "shipped-artifact",
        },
      );
    };

    const [leftGraph, rightGraph, repackedGraph] = await Promise.all([
      evidenceFor(leftRom, "left.nds"),
      evidenceFor(rightRom, "right.nds"),
      evidenceFor(repackedRom, "repacked.nds"),
    ]);

    const addressDiff = compareArtifacts(leftGraph, rightGraph);
    expect(
      addressDiff.changes.find((change) => change.logical_path === "arm9.bin"),
    ).toMatchObject({
      classification: "changed",
      dimensions: ["metadata"],
    });
    expect(
      addressDiff.changes.find(
        (change) => change.logical_path === "overlays/arm9/overlay_0000.bin",
      ),
    ).toMatchObject({
      classification: "changed",
      dimensions: ["metadata"],
    });
    expect(
      addressDiff.changes.find((change) => change.logical_path === "arm7.bin"),
    ).toBeUndefined();

    const repackedDiff = compareArtifacts(leftGraph, repackedGraph);
    expect(
      repackedDiff.changes.find(
        (change) => change.logical_path === "data/readme.txt",
      ),
    ).toBeUndefined();
    expect(
      repackedDiff.changes.find(
        (change) => change.logical_path === "data/data/a.bin",
      ),
    ).toBeUndefined();
  });
});
