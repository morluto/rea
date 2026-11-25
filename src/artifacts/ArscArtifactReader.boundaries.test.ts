import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { text } from "node:stream/consumers";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import {
  ARSC_BASIC_TYPES,
  ARSC_BASIC_VALUES,
  buildArsc,
} from "../../tests/fixtures/arsc.js";

import type {
  ArtifactEntry,
  ArtifactTraversalOptions,
} from "../resources/ArtifactReader.js";
import { ArscArtifactReader } from "./ArscArtifactReader.js";

const writeDocument = async (bytes: Buffer): Promise<string> => {
  const path = join(
    await createTestTempDirectory("rea-arsc-boundary-"),
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

const xmlOf = async (reader: ArscArtifactReader): Promise<string> =>
  text(await reader.open((await list(reader))[0]!));

const basicBytes = (): Buffer =>
  buildArsc({ types: ARSC_BASIC_TYPES, values: ARSC_BASIC_VALUES });

describe("arsc decoder limits", () => {
  it("fails closed on an over-limit global string count", async () => {
    const bytes = basicBytes();
    // Global pool stringCount is the first u32 of the pool at offset 20.
    bytes.writeUInt32LE(0x100001, 20);
    await withReader(bytes, async (reader) => {
      await expect(list(reader)).rejects.toMatchObject({
        reason: "limit",
        boundary: "capacity",
      });
    });
  });

  it("fails closed on an over-limit declared file", async () => {
    const padded = Buffer.alloc(64 * 1024 * 1024 + 1);
    basicBytes().copy(padded, 0);
    await withReader(padded, async (reader) => {
      await expect(list(reader)).rejects.toMatchObject({
        reason: "limit",
      });
    });
  });

  it("fails closed on an over-limit package count", async () => {
    const bytes = basicBytes();
    bytes.writeUInt32LE(0x101, 8);
    await withReader(bytes, async (reader) => {
      await expect(list(reader)).rejects.toMatchObject({
        reason: "limit",
        boundary: "capacity",
      });
    });
  });
});

describe("arsc malformed extents", () => {
  it("rejects a chunk extending past the declared document", async () => {
    const bytes = buildArsc({
      types: ARSC_BASIC_TYPES,
      values: ARSC_BASIC_VALUES,
      declaredSize: 24,
    });
    await withReader(bytes, async (reader) => {
      await expect(list(reader)).rejects.toMatchObject({ reason: "malformed" });
    });
  });

  it("rejects a type id with no name in the type pool", async () => {
    const bytes = basicBytes();
    // type chunks open with u16 0x0201 + u16 headerSize 48 (0x30).
    const spec = bytes.indexOf(Buffer.from([0x02, 0x02, 0x10, 0x00]));
    expect(spec).toBeGreaterThan(0);
    bytes.writeUInt8(9, spec + 8);
    const type = bytes.indexOf(Buffer.from([0x01, 0x02, 0x30, 0x00]), spec);
    expect(type).toBeGreaterThan(spec);
    bytes.writeUInt8(9, type + 8);
    await withReader(bytes, async (reader) => {
      await expect(list(reader)).rejects.toMatchObject({ reason: "malformed" });
    });
  });

  it("rejects an entry offset outside the entry block", async () => {
    const bytes = basicBytes();
    const type = bytes.indexOf(Buffer.from([0x01, 0x02, 0x30, 0x00]));
    expect(type).toBeGreaterThan(0);
    const headerSize = bytes.readUInt16LE(type + 2);
    bytes.writeUInt32LE(0x7fffff00, type + headerSize);
    await withReader(bytes, async (reader) => {
      await expect(list(reader)).rejects.toMatchObject({ reason: "malformed" });
    });
  });

  it("rejects an unexpected chunk inside the package", async () => {
    const mystery = Buffer.alloc(8);
    mystery.writeUInt16LE(0x0300, 0);
    mystery.writeUInt16LE(8, 2);
    mystery.writeUInt32LE(8, 4);
    const bytes = buildArsc({
      types: ARSC_BASIC_TYPES,
      values: ARSC_BASIC_VALUES,
      tailChunks: [mystery],
    });
    await withReader(bytes, async (reader) => {
      await expect(list(reader)).rejects.toMatchObject({ reason: "malformed" });
    });
  });

  it("rejects a table declaring zero packages", async () => {
    const pool = basicBytes().subarray(0, 12);
    // Keep only the header; body removed so nothing was walked.
    const header = Buffer.concat([
      Buffer.from([0x02, 0x00, 0x0c, 0x00]),
      Buffer.alloc(4),
      Buffer.alloc(4),
    ]);
    header.writeUInt32LE(12, 4);
    header.writeUInt32LE(0, 8);
    await withReader(
      Buffer.concat([header, pool.subarray(12)]),
      async (reader) => {
        await expect(list(reader)).rejects.toMatchObject({
          reason: "malformed",
        });
      },
    );
  });

  it("reports an incomplete table as unknown coverage, not success", async () => {
    const bytes = buildArsc({
      types: ARSC_BASIC_TYPES,
      values: ARSC_BASIC_VALUES,
      declaredSize: 64 * 1024 * 1024,
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
      expect(coverage?.status).toBe("unknown");
    });
  });

  it("reports trailing bytes past the declared size as a limitation", async () => {
    const real = buildArsc({
      types: ARSC_BASIC_TYPES,
      values: ARSC_BASIC_VALUES,
    });
    const padded = Buffer.concat([real, Buffer.alloc(4)]);
    await withReader(padded, async (reader) => {
      let coverage:
        | { status: string; limitations: readonly string[] }
        | undefined;
      await list(reader, {
        onCoverage: (c) => {
          coverage = c;
        },
      });
      expect(coverage?.limitations.join(" ")).toContain("trailing");
    });
  });

  it("decodes packed base-'a' language and base-'0' region triplets", async () => {
    const bytes = buildArsc({
      types: [
        {
          name: "string",
          config: { size: 28 },
          entries: [{ name: "k", typed: [0x10, 1] }],
        },
      ],
    });
    // Type chunk: 0x01 0x02 + u16 headerSize (20 + configSize 28 = 0x30).
    const type = bytes.indexOf(Buffer.from([0x01, 0x02, 0x30, 0x00]));
    expect(type).toBeGreaterThan(0);
    // Config language/region live at base+8/+10 inside the type header.
    bytes.writeUInt8(0xad, type + 28); // packed "fil": f|i<<5|l<<10 | 0x8000
    bytes.writeUInt8(0x05, type + 29);
    bytes.writeUInt8(0xa4, type + 30); // packed "419": 4|1<<5|9<<10 | 0x8000
    bytes.writeUInt8(0x24, type + 31);
    await withReader(bytes, async (reader) => {
      const xml = await xmlOf(reader);
      expect(xml).toContain('config="fil-r419"');
    });
  });

  it("renders orientation, night and smallest-width qualifiers", async () => {
    const bytes = buildArsc({
      types: [
        {
          name: "string",
          config: { size: 32 },
          entries: [{ name: "k", typed: [0x10, 1] }],
        },
      ],
    });
    const type = bytes.indexOf(Buffer.from([0x01, 0x02, 0x34, 0x00]));
    expect(type).toBeGreaterThan(0);
    bytes.writeUInt8(2, type + 20 + 12); // orientation land
    bytes.writeUInt8(0x20, type + 20 + 29); // uiMode night bit
    bytes.writeUInt16LE(320, type + 20 + 30); // smallestWidth 320dp
    await withReader(bytes, async (reader) => {
      const xml = await xmlOf(reader);
      expect(xml).toContain("land");
      expect(xml).toContain("night");
      expect(xml).toContain("sw320dp");
    });
  });

  it("keeps undecoded config fields explicit instead of default", async () => {
    const bytes = buildArsc({
      types: [
        {
          name: "string",
          config: { size: 40 },
          entries: [{ name: "k", typed: [0x10, 1] }],
        },
      ],
    });
    await withReader(bytes, async (reader) => {
      const xml = await xmlOf(reader);
      expect(xml).toContain('config="fields40"');
      expect(xml).not.toContain('config="default"');
    });
  });
});

describe("arsc entry layouts", () => {
  it("decodes sparse entry slots pairing index and offset", async () => {
    const bytes = buildArsc({
      values: ARSC_BASIC_VALUES,
      types: [
        {
          name: "string",
          layout: "sparse",
          entries: [
            { name: "app_name", typed: [0x03, 0] },
            { name: "theme", typed: [0x01, 0x7f0d0001] },
          ],
        },
      ],
    });
    await withReader(bytes, async (reader) => {
      const xml = await xmlOf(reader);
      expect(xml).toContain('name="app_name" value="Fanqie Novel"');
      expect(xml).toContain('id="0x7f010001" name="theme"');
    });
  });

  it("decodes offset16 entry slots in 4-byte units", async () => {
    const bytes = buildArsc({
      values: ARSC_BASIC_VALUES,
      types: [
        {
          name: "string",
          layout: "offset16",
          entries: [
            { name: "app_name", typed: [0x03, 0] },
            { name: "theme", typed: [0x01, 0x7f0d0001] },
          ],
        },
      ],
    });
    await withReader(bytes, async (reader) => {
      const xml = await xmlOf(reader);
      expect(xml).toContain('name="app_name" value="Fanqie Novel"');
      expect(xml).toContain('id="0x7f010001" name="theme"');
    });
  });

  it("decodes compact entries without a trailing Res_value", async () => {
    const bytes = buildArsc({
      values: ARSC_BASIC_VALUES,
      types: [
        {
          name: "string",
          layout: "compact",
          entries: [
            { name: "app_name", typed: [0x03, 0] },
            { name: "theme", typed: [0x01, 0x7f0d0001] },
          ],
        },
      ],
    });
    await withReader(bytes, async (reader) => {
      const xml = await xmlOf(reader);
      expect(xml).toContain('name="app_name" value="Fanqie Novel"');
      expect(xml).toContain('id="0x7f010001" name="theme"');
    });
  });

  it("rejects conflicting sparse+offset16 layout flags", async () => {
    const bytes = buildArsc({
      types: ARSC_BASIC_TYPES,
      values: ARSC_BASIC_VALUES,
    });
    const type = bytes.indexOf(Buffer.from([0x01, 0x02, 0x30, 0x00]));
    expect(type).toBeGreaterThan(0);
    bytes.writeUInt8(0x03, type + 9);
    await withReader(bytes, async (reader) => {
      await expect(list(reader)).rejects.toMatchObject({ reason: "malformed" });
    });
  });

  it("rejects a simple entry with an invalid Res_value header", async () => {
    const bytes = buildArsc({
      types: [
        { name: "attr", entries: [{ name: "versionCode", typed: [0x10, 3] }] },
      ],
    });
    const type = bytes.indexOf(Buffer.from([0x01, 0x02, 0x30, 0x00]));
    expect(type).toBeGreaterThan(0);
    const headerSize = bytes.readUInt16LE(type + 2);
    const entriesStart = bytes.readUInt32LE(type + 16);
    const entryBase = type + entriesStart;
    bytes.writeUInt16LE(4, entryBase + 8); // Res_value.size below 8
    await withReader(bytes, async (reader) => {
      await expect(list(reader)).rejects.toMatchObject({ reason: "malformed" });
    });
  });

  it("rejects a type-spec flag count above the entry bound", async () => {
    const bytes = buildArsc({
      types: ARSC_BASIC_TYPES,
      values: ARSC_BASIC_VALUES,
    });
    const spec = bytes.indexOf(Buffer.from([0x02, 0x02, 0x10, 0x00]));
    expect(spec).toBeGreaterThan(0);
    bytes.writeUInt32LE(0x100001, spec + 12);
    await withReader(bytes, async (reader) => {
      await expect(list(reader)).rejects.toMatchObject({ reason: "limit" });
    });
  });

  it("fails closed on pool strings XML cannot represent", async () => {
    const bytes = buildArsc({
      types: [
        {
          name: "attr",
          entries: [{ name: "badname", typed: [0x10, 1] }],
        },
      ],
    });
    await withReader(bytes, async (reader) => {
      await expect(list(reader)).rejects.toMatchObject({ reason: "malformed" });
    });
  });

  it("fails closed on package names XML cannot represent", async () => {
    const bytes = buildArsc({
      packageName: "com.example.app",
      types: ARSC_BASIC_TYPES,
      values: ARSC_BASIC_VALUES,
    });
    await withReader(bytes, async (reader) => {
      await expect(list(reader)).rejects.toMatchObject({ reason: "malformed" });
    });
  });

  it("accepts a 284-byte package header without typeIdOffset", async () => {
    const bytes = buildArsc({
      packageHeaderSize: 284,
      types: ARSC_BASIC_TYPES,
      values: ARSC_BASIC_VALUES,
    });
    await withReader(bytes, async (reader) => {
      const xml = await xmlOf(reader);
      expect(xml).toContain('<package id="0x0000007f"');
      expect(xml).toContain('name="app_name"');
    });
  });
});
