import { describe, expect, it } from "vitest";

import { createTestTempFile } from "../../tests/fixtures/temporaryDirectory.js";
import type {
  ArtifactEntry,
  ArtifactReaderTraversal,
} from "../resources/index.js";
import {
  NDS_FIXTURE,
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
});
