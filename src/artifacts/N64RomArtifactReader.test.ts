import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { buffer } from "node:stream/consumers";

import { describe, expect, it } from "vitest";

import { classifyArtifactBytesAtPath } from "../../tests/fixtures/artifactClassification.js";
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
import { n64RomFixture, n64RomImage } from "../domain/n64Rom.fixture.js";
import {
  N64_CHECKSUM_END,
  N64_HEADER_BYTES,
  N64_IPL3_END,
  N64_IPL3_OFFSET,
} from "../domain/n64Rom.js";
import type {
  ArtifactEntry,
  ArtifactReaderTraversal,
} from "../resources/index.js";
import { N64RomArtifactReader } from "./N64RomArtifactReader.js";

const digest = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const write = (bytes: Buffer, name = "game.z64"): Promise<string> =>
  createTestTempFile("rea-n64-", name, bytes);

const read = async (bytes: Buffer) => {
  const reader = new N64RomArtifactReader(await write(bytes));
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

describe("Nintendo 64 ROM reader", () => {
  it.each(["z64", "v64", "n64"] as const)(
    "serves one big-endian image from a %s dump",
    async (order) => {
      const image = n64RomImage({ order });
      const result = await read(image.encoded);
      expect(result.metadata).toMatchObject({
        kind: "n64-rom",
        source_order: order,
        cic: "6102/7101",
        boot_address: 0x8000_0400,
        clock_rate: 0x0f,
        cartridge_id: "RE",
        destination_code: "E",
        destination_name: "North America",
        media_name: "cartridge",
        title_ascii: "REA TEST".padEnd(20, " "),
        crc: { status: "match" },
      });
      expect(result.coverage[0]).toMatchObject({
        status: "unknown",
        limitations: [expect.stringContaining("taken as zero")],
      });
      expect(result.entries.map((entry) => entry.path)).toEqual([
        "header.bin",
        "ipl3.bin",
        "program.z64",
      ]);
      const decoded = order !== "z64";
      expect(result.entries.map((entry) => entry.formatMetadata)).toEqual([
        {
          kind: "n64-rom-entry",
          role: "header",
          source_order: order,
          decoded,
        },
        {
          kind: "n64-rom-entry",
          role: "ipl3",
          source_order: order,
          decoded,
        },
        {
          kind: "n64-rom-entry",
          role: "program",
          source_order: order,
          decoded,
        },
      ]);
      expect(
        result.contents
          .get("header.bin")
          ?.equals(image.normalized.subarray(0, N64_HEADER_BYTES)),
      ).toBe(true);
      expect(
        result.contents
          .get("ipl3.bin")
          ?.equals(image.normalized.subarray(N64_IPL3_OFFSET, N64_IPL3_END)),
      ).toBe(true);
      expect(result.contents.get("program.z64")?.equals(image.normalized)).toBe(
        true,
      );
    },
  );

  it("classifies every byte order as an n64-rom archive, ignoring the name", async () => {
    for (const order of ["z64", "v64", "n64"] as const) {
      const encoded = n64RomImage({ order }).encoded;
      expect(classifyArtifactBytesAtPath("rom.bin", encoded)).toEqual({
        kind: "container",
        format: "n64-rom",
      });
      expect(
        await parseBinaryTarget(await write(encoded, "rom.bin")),
      ).toMatchObject({
        ok: true,
        value: { kind: "archive", format: "n64-rom" },
      });
    }
  });

  it("hashes program.z64 as the normalized image", async () => {
    const image = n64RomImage({ order: "v64" });
    const graph = await inventoryArtifact(
      await write(image.encoded, "game.v64"),
    );
    expect(graph.manifest.root_format).toBe("n64-rom");
    expect(graph.manifest.root_sha256).toBe(digest(image.encoded));
    expect(graph.coverage.status).toBe("unknown");
    const program = graph.occurrences.find(
      (row) => row.logical_path === "program.z64",
    );
    expect(program).toMatchObject({
      hash_status: "verified",
      format_metadata: {
        kind: "n64-rom-entry",
        role: "program",
        source_order: "v64",
        decoded: true,
      },
    });
    expect(
      graph.nodes.find((node) => node.artifact_id === program?.artifact_id)
        ?.sha256,
    ).toBe(digest(image.normalized));
    expect(digest(image.encoded)).not.toBe(digest(image.normalized));
    expect(
      graph.occurrences.find((row) => row.logical_path === ".")
        ?.format_metadata,
    ).toMatchObject({
      kind: "n64-rom",
      source_order: "v64",
      cic: "6102/7101",
    });
  });

  it("extracts program.z64 byte-identical to the big-endian image", async () => {
    const image = n64RomImage({ order: "n64" });
    const path = await write(n64RomFixture({ order: "n64" }), "game.n64");
    const snapshot = await scanCanonicalArtifactInventory(path);
    const selected = snapshot.occurrences
      .filter((row) => row.logical_path === "program.z64")
      .map((row) => row.occurrence_id);
    expect(selected).toHaveLength(1);
    const output = join(await createTestTempDirectory("rea-n64-out-"), "out");
    const extracted = await materializeArtifactInventory(
      {
        inputPath: path,
        inputFormat: "n64-rom",
        outputRoot: output,
        occurrenceIds: selected,
        environment: process.env,
        integrityPolicy: "fail",
      },
      path,
      snapshot,
    );
    expect(
      extracted.artifacts.map((artifact) => artifact.relative_path),
    ).toEqual(["program.z64"]);
    expect(
      (await readFile(join(output, "program.z64"))).equals(image.normalized),
    ).toBe(true);
  });

  it("reports complete coverage when the checksum window is present and matches", async () => {
    const result = await read(n64RomImage({ fullWindow: true }).encoded);
    expect(result.metadata?.rom_bytes).toBe(N64_CHECKSUM_END);
    expect(result.coverage).toEqual([{ status: "complete", limitations: [] }]);
    expect(result.metadata?.crc.status).toBe("match");
  });
});
