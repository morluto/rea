import { expect, it } from "vitest";

import { createTestTempFile } from "../../tests/fixtures/temporaryDirectory.js";
import { amigaLoadFile } from "../domain/amigaHunk.fixture.js";
import type { AmigaHunkLimits } from "../domain/amigaHunk.js";
import type {
  ArtifactEntry,
  ArtifactReaderTraversal,
} from "../resources/index.js";
import { AmigaHunkArtifactReader } from "./AmigaHunkArtifactReader.js";

const CODE = Buffer.from([0x4e, 0x75, 0x00, 0x00]);

const read = async (bytes: Buffer, limits?: AmigaHunkLimits) => {
  const reader = new AmigaHunkArtifactReader(
    await createTestTempFile("rea-amiga-hunk-boundary-", "program.hunk", bytes),
    undefined,
    limits,
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

it("reports a truncated header as unknown coverage and no entries", async () => {
  const result = await read(Buffer.from([0x00, 0x00, 0x03, 0xf3]));
  expect(result.entries).toEqual([]);
  expect(result.coverage).toMatchObject({ status: "unknown" });
  expect(result.metadata?.limitations.map((item) => item.kind)).toEqual([
    "truncated",
  ]);
  expect(result.coverage?.limitations[0]).toContain("Truncated");
});

it("refuses a file above the file allowance before reading it", async () => {
  const bytes = amigaLoadFile({ hunks: [{ type: "code", bytes: CODE }] });
  await expect(read(bytes, { maxFileBytes: 8 })).rejects.toMatchObject({
    reason: "limit",
    boundary: "capacity",
    fixedAllowance: {
      name: "The Amiga Hunk file allowance",
      limit: 8,
      unit: "bytes",
    },
  });
});

it("refuses a hunk table above the constructor hunk ceiling", async () => {
  const bytes = Buffer.alloc(20 + 3 * 4);
  bytes.writeUInt32BE(0x3f3, 0);
  bytes.writeUInt32BE(0, 4);
  bytes.writeUInt32BE(3, 8);
  bytes.writeUInt32BE(0, 12);
  bytes.writeUInt32BE(2, 16);
  await expect(read(bytes, { maxHunks: 2 })).rejects.toMatchObject({
    reason: "limit",
    boundary: "capacity",
    fixedAllowance: {
      name: "The Amiga Hunk hunk-count allowance",
      limit: 2,
      unit: "hunks",
    },
  });
});

it("refuses a relocation group above the constructor relocation ceiling", async () => {
  await expect(
    read(
      amigaLoadFile({
        hunks: [
          {
            type: "code",
            bytes: CODE,
            relocs: [{ kind: "reloc32", target: 0, offsets: [0, 0] }],
          },
        ],
      }),
      { maxRelocations: 1 },
    ),
  ).rejects.toMatchObject({
    reason: "limit",
    boundary: "capacity",
    fixedAllowance: {
      name: "The Amiga Hunk relocation allowance",
      limit: 1,
      unit: "relocations",
    },
  });
});

it("refuses a name above the constructor symbol-byte ceiling", async () => {
  await expect(
    read(
      amigaLoadFile({
        libraries: ["ab"],
        hunks: [
          {
            type: "code",
            bytes: CODE,
            symbols: [{ name: "start", offset: 0 }],
          },
        ],
      }),
      { maxSymbolBytes: 4 },
    ),
  ).rejects.toMatchObject({
    reason: "limit",
    boundary: "capacity",
    fixedAllowance: {
      name: "The Amiga Hunk symbol-byte allowance",
      limit: 4,
      unit: "bytes",
    },
  });
});

it("keeps the code hunk when a later block type is unknown", async () => {
  const result = await read(
    amigaLoadFile({
      hunks: [{ type: "code", bytes: CODE, unknownBeforeEnd: 0x3ef }],
    }),
  );
  expect(result.entries.map((entry) => entry.path)).toEqual([
    "hunk-0-code.bin",
  ]);
  expect(result.coverage?.status).toBe("unknown");
  expect(result.metadata?.limitations.map((item) => item.kind)).toEqual([
    "unknown-block",
  ]);
});

it("keeps a truncated over-count hunk table instead of refusing it", async () => {
  const header = Buffer.alloc(20);
  header.writeUInt32BE(0x3f3, 0);
  header.writeUInt32BE(0, 4);
  header.writeUInt32BE(1025, 8);
  header.writeUInt32BE(0, 12);
  header.writeUInt32BE(1024, 16);
  const truncated = await read(header);
  expect(truncated.entries).toEqual([]);
  expect(truncated.metadata).toMatchObject({
    table_size: 1025,
    first_hunk: 0,
    last_hunk: 1024,
    hunks: [],
  });
  expect(truncated.metadata?.limitations.map((item) => item.kind)).toEqual([
    "truncated",
  ]);
  expect(truncated.coverage).toMatchObject({ status: "unknown" });

  const possible = Buffer.alloc(20 + 1025 * 4);
  header.copy(possible);
  await expect(read(possible)).rejects.toMatchObject({
    reason: "limit",
    boundary: "capacity",
    fixedAllowance: {
      name: "The Amiga Hunk hunk-count allowance",
      limit: 1024,
      unit: "hunks",
    },
  });
});

it("reports a relocation that names a hunk the header does not list", async () => {
  const result = await read(
    amigaLoadFile({
      hunks: [
        {
          type: "code",
          bytes: CODE,
          relocs: [{ kind: "reloc32", target: 4, offsets: [0] }],
        },
      ],
    }),
  );
  expect(result.entries).toHaveLength(1);
  expect(result.metadata?.hunks[0]?.relocations).toEqual([
    { kind: "reloc32", target_hunk: 4, count: 1 },
  ]);
  expect(result.metadata?.limitations.map((item) => item.kind)).toEqual([
    "relocation-target",
  ]);
});

it("reports a relocation past the hunk size and still counts it", async () => {
  const result = await read(
    amigaLoadFile({
      hunks: [
        {
          type: "code",
          bytes: CODE,
          relocs: [{ kind: "reloc32", target: 0, offsets: [8] }],
        },
      ],
    }),
  );
  expect(result.entries).toHaveLength(1);
  expect(result.metadata?.hunks[0]?.relocations[0]?.count).toBe(1);
  expect(result.metadata?.limitations.map((item) => item.kind)).toEqual([
    "relocation-offset",
  ]);
});

it("treats a hostile hunk length as a size mismatch and truncation", async () => {
  const file = amigaLoadFile({ hunks: [{ type: "code", bytes: CODE }] });
  const cut = Buffer.from(file.subarray(0, 32));
  cut.writeUInt32BE(0x0fff_ffff, 28);
  const result = await read(cut);
  expect(result.entries).toEqual([]);
  expect(result.metadata?.limitations.map((item) => item.kind)).toEqual([
    "size-mismatch",
    "truncated",
  ]);
  expect(result.coverage?.status).toBe("unknown");
});
