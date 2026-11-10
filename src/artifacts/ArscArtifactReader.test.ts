import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { text } from "node:stream/consumers";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { scanCanonicalArtifactInventory } from "../../tests/fixtures/artifactInventory.js";
import {
  ARSC_BASIC_TYPES,
  ARSC_BASIC_VALUES,
  buildArsc,
} from "../../tests/fixtures/arsc.js";

import type {
  ArtifactEntry,
  ArtifactTraversalOptions,
} from "./ArtifactReader.js";
import { hasArscHeader, readArscHeaderFacts } from "../domain/arscFormat.js";
import { ArscArtifactReader } from "./ArscArtifactReader.js";

const writeDocument = async (bytes: Buffer): Promise<string> => {
  const path = join(
    await createTestTempDirectory("rea-arsc-"),
    "resources.arsc",
  );
  await writeFile(path, bytes);
  return path;
};

const list = async (
  reader: ArscArtifactReader,
  options?: ArtifactTraversalOptions,
): Promise<ArtifactEntry[]> => {
  const entries: ArtifactEntry[] = [];
  for await (const entry of reader.entries(undefined, options))
    entries.push(entry);
  return entries;
};

const withReader = async <T>(
  bytes: Buffer,
  use: (reader: ArscArtifactReader) => Promise<T>,
): Promise<T> => {
  const reader = new ArscArtifactReader(await writeDocument(bytes));
  try {
    return await use(reader);
  } finally {
    await reader.close();
  }
};

const basicBytes = (): Buffer =>
  buildArsc({ types: ARSC_BASIC_TYPES, values: ARSC_BASIC_VALUES });

describe("hasArscHeader", () => {
  it("recognizes the RES_TABLE_TYPE preamble only", () => {
    expect(hasArscHeader(basicBytes())).toBe(true);
    expect(hasArscHeader(Buffer.from("PK\x03\x04"))).toBe(false);
    expect(hasArscHeader(Buffer.alloc(4))).toBe(false);
    // Malformed tables keep format identity; the decoder reports details.
    expect(
      hasArscHeader(
        Buffer.from([0x02, 0x00, 0x0c, 0x00, 1, 2, 3, 4, 0, 0, 0, 0]),
      ),
    ).toBe(true);
    expect(
      hasArscHeader(Buffer.from([0x03, 0x00, 0x08, 0x00, 1, 2, 3, 4])),
    ).toBe(false);
  });
});

describe("readArscHeaderFacts", () => {
  it("reads the declared size and package count", () => {
    const bytes = basicBytes();
    expect(readArscHeaderFacts(bytes)).toEqual({
      declaredSize: bytes.length,
      packageCount: 1,
    });
    expect(readArscHeaderFacts(Buffer.alloc(32))).toBeUndefined();
  });
});

describe("ArscArtifactReader", () => {
  it("decodes a resource table into the XML projection region", async () => {
    const bytes = basicBytes();
    await withReader(bytes, async (reader) => {
      const entries = await list(reader);
      expect(entries.map((entry) => entry.path)).toEqual(["resources.xml"]);
      expect(reader.formatMetadata()).toMatchObject({
        kind: "arsc",
        package_count: 1,
        type_count: 2,
        entry_count: 4,
        string_count: 1,
        declared_size: bytes.length,
      });
      const xml = await text(await reader.open(entries[0]!));
      expect(xml).toContain("<resources>");
      expect(xml).toContain('<package id="0x0000007f" name="com.example.app">');
      expect(xml).toContain(
        '<type id="0x00000001" name="attr" config="default">',
      );
      expect(xml).toContain(
        'id="0x7f010000" name="versionCode" public="true" value="3"',
      );
    });
  });

  it("resolves TYPE_STRING data through the global string pool", async () => {
    await withReader(basicBytes(), async (reader) => {
      const xml = await text(await reader.open((await list(reader))[0]!));
      expect(xml).toContain('name="app_name" value="Fanqie Novel"');
    });
  });

  it("renders config qualifiers on non-default type chunks", async () => {
    await withReader(basicBytes(), async (reader) => {
      const xml = await text(await reader.open((await list(reader))[0]!));
      expect(xml).toContain('name="string" config="en-rUS-480dpi-v35"');
    });
  });

  it("projects complex bag entries with parent and items", async () => {
    await withReader(basicBytes(), async (reader) => {
      const xml = await text(await reader.open((await list(reader))[0]!));
      expect(xml).toContain('name="gravityBag" parent="0x7f010001"');
      expect(xml).toContain('<item name="@0x01010000" value="17"/>');
      expect(xml).toContain('<item name="@0x01010001" value="true"/>');
      expect(xml).toContain("</entry>");
    });
  });

  it("renders reference types with their resource-id sigils", async () => {
    await withReader(basicBytes(), async (reader) => {
      const xml = await text(await reader.open((await list(reader))[0]!));
      expect(xml).toContain('name="theme" value="@0x7f0d0001"');
    });
  });

  it("walks library/overlay chunks and reports them as limitations", async () => {
    const library = Buffer.alloc(12);
    library.writeUInt16LE(0x0203, 0);
    library.writeUInt16LE(12, 2);
    library.writeUInt32LE(12, 4);
    const bytes = buildArsc({
      types: ARSC_BASIC_TYPES,
      values: ARSC_BASIC_VALUES,
      tailChunks: [library],
    });
    await withReader(bytes, async (reader) => {
      let coverage:
        | { status: string; limitations: readonly string[] }
        | undefined;
      await list(reader, {
        onCoverage: (c) => {
          coverage = c;
        },
      });
      expect(coverage?.limitations.join(" ")).toContain(
        "walked but not projected",
      );
    });
  });

  it("fails closed when a package precedes the global string pool", async () => {
    const bytes = basicBytes();
    // The global pool is the first chunk at offset 12; flip its type.
    bytes.writeUInt16LE(0x0200, 12);
    await withReader(bytes, async (reader) => {
      await expect(list(reader)).rejects.toMatchObject({ reason: "format" });
    });
  });
});

describe("arsc inventory", () => {
  it("classifies and inventories the table via the canonical scan", async () => {
    const inventory = await scanCanonicalArtifactInventory(
      await writeDocument(basicBytes()),
    );
    expect(inventory.manifest.root_format).toBe("arsc");
    expect(inventory.coverage.status).toBe("complete");
    expect(inventory.occurrences.map((row) => row.logical_path).sort()).toEqual(
      [".", "resources.xml"],
    );
  });
});
