import { writeFile } from "node:fs/promises";
import { join } from "node:path";

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
} from "./ArtifactReader.js";
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
      await expect(list(reader)).rejects.toMatchObject({ reason: "format" });
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
      await expect(list(reader)).rejects.toMatchObject({ reason: "format" });
    });
  });

  it("rejects an entry offset outside the entry block", async () => {
    const bytes = basicBytes();
    const type = bytes.indexOf(Buffer.from([0x01, 0x02, 0x30, 0x00]));
    expect(type).toBeGreaterThan(0);
    const headerSize = bytes.readUInt16LE(type + 2);
    bytes.writeUInt32LE(0x7fffff00, type + headerSize);
    await withReader(bytes, async (reader) => {
      await expect(list(reader)).rejects.toMatchObject({ reason: "format" });
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
      await expect(list(reader)).rejects.toMatchObject({ reason: "format" });
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
        await expect(list(reader)).rejects.toMatchObject({ reason: "format" });
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
});
