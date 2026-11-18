import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { expect, it } from "vitest";

import { scanCanonicalArtifactInventory } from "../../tests/fixtures/artifactInventory.js";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { parseMacosFseventsBytes } from "../domain/apple/macosFsevents.js";
import {
  FSEVENTS_INLINE_BLOCK_LIMIT,
  FSEVENTS_INLINE_DIAGNOSTIC_LIMIT,
  FSEVENTS_INLINE_EVENT_LIMIT,
  FSEVENTS_MAX_DECOMPRESSED_BYTES,
  FSEVENTS_MAX_FILE_BYTES,
  FSEVENTS_MAX_INLINE_PATH_BYTES,
  type MacosFseventsStoreVersion,
} from "../domain/apple/macosFseventsFlags.js";
import { MacosFseventsArtifactReader } from "./MacosFseventsArtifactReader.js";

interface RecordFixtureInput {
  readonly pathBytes: Buffer | string;
  readonly eventId: bigint;
  readonly flags: number;
  readonly nodeId?: bigint;
  readonly extraWord?: number;
}

const buildDlsRecord = (
  version: MacosFseventsStoreVersion,
  entry: RecordFixtureInput,
): Buffer => {
  const pathBuf =
    typeof entry.pathBytes === "string"
      ? Buffer.from(entry.pathBytes, "utf8")
      : entry.pathBytes;
  const suffixLength = version === "1SLD" ? 12 : version === "2SLD" ? 20 : 24;
  const out = Buffer.alloc(pathBuf.length + 1 + suffixLength);
  pathBuf.copy(out, 0);
  out[pathBuf.length] = 0;
  const offset = pathBuf.length + 1;
  out.writeBigUInt64LE(entry.eventId, offset);
  out.writeUInt32LE(entry.flags >>> 0, offset + 8);
  if (version === "2SLD" || version === "3SLD")
    out.writeBigUInt64LE(entry.nodeId ?? 0n, offset + 12);
  if (version === "3SLD")
    out.writeUInt32LE((entry.extraWord ?? 0) >>> 0, offset + 20);
  return out;
};

const buildDlsBlock = (options: {
  readonly version: MacosFseventsStoreVersion;
  readonly reservedWord?: number;
  readonly records?: readonly RecordFixtureInput[];
  readonly extraBody?: Buffer;
  readonly declaredSizeOverride?: number;
}): Buffer => {
  const encodedRecords = (options.records ?? []).map((record) =>
    buildDlsRecord(options.version, record),
  );
  const body = Buffer.concat([
    ...encodedRecords,
    ...(options.extraBody === undefined ? [] : [options.extraBody]),
  ]);
  const declaredSize = options.declaredSizeOverride ?? 12 + body.length;
  const header = Buffer.alloc(12);
  header.write(options.version, 0, "latin1");
  header.writeUInt32LE((options.reservedWord ?? 0) >>> 0, 4);
  header.writeUInt32LE(declaredSize >>> 0, 8);
  return Buffer.concat([header, body]);
};

const writeStoreFile = async (name: string, bytes: Buffer): Promise<string> => {
  const dir = await createTestTempDirectory("rea-fsevents-");
  const filePath = join(dir, name);
  await writeFile(filePath, bytes);
  return filePath;
};

it("inventories a gzipped 2SLD store end to end with UTF-8 paths and 64-bit IDs", async () => {
  const block = buildDlsBlock({
    version: "2SLD",
    reservedWord: 0x1122_3344,
    records: [
      {
        pathBytes: "/Users/alice/Documents/报告.txt",
        eventId: 0x0001_0000_0000_0010n,
        flags: 0x0080_0001, // File | Created
        nodeId: 0x0002_0000_0000_1234n,
      },
      {
        pathBytes: "/Volumes/USB",
        eventId: 0x0001_0000_0000_0011n,
        flags: 0x2200_0000, // Mount | EndOfTransaction
        nodeId: 2n,
      },
      {
        pathBytes: "/Volumes/USB",
        eventId: 0x0001_0000_0000_0012n,
        flags: 0x0402_0000, // Unmount | TruncatedPath
        nodeId: 2n,
      },
    ],
  });
  const path = await writeStoreFile("0000000000000100", gzipSync(block));
  const inventory = await scanCanonicalArtifactInventory(path);

  expect(inventory.manifest.root_format).toBe("macos-fsevents");
  expect(inventory.coverage.status).toBe("complete");
  expect(inventory.occurrences.map((row) => row.logical_path)).toEqual(["."]);
  expect(inventory.limitations.join(" ")).toContain(
    "Directory-wide rotation correlation",
  );
  expect(inventory.occurrences[0]).toMatchObject({
    artifact_kind: "resource",
    artifact_format: "macos-fsevents",
    format_metadata: {
      kind: "macos-fsevents",
      compression: "gzip",
      decompressed_bytes: block.length,
      store_versions: ["2SLD"],
      block_count: 1,
      omitted_blocks: 0,
      record_count: 3,
      omitted_records: 0,
      first_event_id: String(0x0001_0000_0000_0010n),
      last_event_id: String(0x0001_0000_0000_0012n),
      out_of_order_record_count: 0,
      duplicate_event_id_count: 0,
      event_id_gap_count: 0,
      mount_event_count: 1,
      unmount_event_count: 1,
      end_of_transaction_count: 1,
      truncated_path_flag_count: 1,
      non_utf8_path_count: 0,
      malformed_record_count: 0,
      records: [
        {
          block_index: 0,
          version: "2SLD",
          event_id: String(0x0001_0000_0000_0010n),
          path: "/Users/alice/Documents/报告.txt",
          path_encoding: "utf-8",
          node_id: String(0x0002_0000_0000_1234n),
          extra_word: null,
          flags: {
            raw: 0x0080_0001,
            raw_hex: "0x00800001",
            names: ["Created", "File"],
            unknown_mask: 0,
          },
        },
        {
          path: "/Volumes/USB",
          flags: { names: ["Mount", "EndOfTransaction"], unknown_mask: 0 },
        },
        {
          path: "/Volumes/USB",
          flags: { names: ["TruncatedPath", "Unmount"], unknown_mask: 0 },
        },
      ],
    },
  });
});

it("joins concatenated multi-member gzip streams (1SLD + 3SLD) and tracks continuity anomalies", async () => {
  const member1 = gzipSync(
    buildDlsBlock({
      version: "1SLD",
      records: [
        { pathBytes: "/a", eventId: 10n, flags: 0x0080_0001 },
        { pathBytes: "/b", eventId: 15n, flags: 0x0080_0010 }, // gap of 4
      ],
    }),
  );
  const member2 = gzipSync(
    buildDlsBlock({
      version: "3SLD",
      records: [
        {
          pathBytes: "/c",
          eventId: 15n, // duplicate
          flags: 0x0100_0080,
          nodeId: 99n,
          extraWord: 42,
        },
        {
          pathBytes: "/d",
          eventId: 12n, // out-of-order
          flags: 0x0080_0002,
          nodeId: 100n,
          extraWord: 7,
        },
      ],
    }),
  );

  const path = await writeStoreFile(
    "0000000000000200",
    Buffer.concat([member1, member2]),
  );
  const inventory = await scanCanonicalArtifactInventory(path);

  expect(inventory.coverage.status).toBe("unknown");
  expect(inventory.limitations.join(" ")).toContain("event ID increment gap");
  expect(inventory.limitations.join(" ")).toContain(
    "lower than the preceding record",
  );
  expect(inventory.occurrences[0]?.format_metadata).toMatchObject({
    kind: "macos-fsevents",
    compression: "gzip",
    store_versions: ["1SLD", "3SLD"],
    block_count: 2,
    record_count: 4,
    event_id_gap_count: 1,
    duplicate_event_id_count: 1,
    out_of_order_record_count: 1,
    records: [
      { version: "1SLD", node_id: null, extra_word: null, event_id: "10" },
      {
        version: "1SLD",
        event_id: "15",
        event_id_gap_from_previous: "4",
      },
      {
        version: "3SLD",
        event_id: "15",
        node_id: "99",
        extra_word: 42,
        duplicate_event_id: true,
      },
      {
        version: "3SLD",
        event_id: "12",
        node_id: "100",
        extra_word: 7,
        out_of_order: true,
      },
    ],
  });
});

it("preserves raw_path_hex on invalid UTF-8 paths, unknown flag bits, and trailing zero padding", () => {
  const badPath = Buffer.from([0x2f, 0xff, 0xfe, 0x2f, 0x61]);
  const block = buildDlsBlock({
    version: "2SLD",
    records: [
      {
        pathBytes: badPath,
        eventId: 1n,
        flags: 0x8000_0001, // bit 31 unknown + Created
        nodeId: 5n,
      },
    ],
  });
  const raw = Buffer.concat([block, Buffer.alloc(16, 0)]);
  const parsed = parseMacosFseventsBytes(raw);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;

  expect(parsed.value.metadata).toMatchObject({
    compression: "none",
    trailing_zero_bytes: 16,
    non_utf8_path_count: 1,
    records: [
      {
        path_encoding: "invalid-utf8",
        raw_path_hex: badPath.toString("hex"),
        flags: {
          raw: 0x8000_0001,
          raw_hex: "0x80000001",
          names: ["Created"],
          unknown_mask: 0x8000_0000,
        },
      },
    ],
  });
  expect(parsed.value.metadata.flag_counts).toEqual([
    { name: "Created", count: 1 },
    { name: "unknown-bits", count: 1 },
  ]);
  expect(parsed.value.limitations.join(" ")).toContain("non-UTF-8");
  expect(parsed.value.limitations.join(" ")).toContain("unknown_mask");
});

it("counts omitted diagnostics accurately when more than 32 invalid UTF-8 paths occur", () => {
  const block = buildDlsBlock({
    version: "1SLD",
    records: Array.from({ length: 40 }, (_, index) => ({
      pathBytes: Buffer.from([0x2f, 0xff, 0xfe, 0x30 + (index % 10)]),
      eventId: BigInt(index + 1),
      flags: 1,
    })),
  });
  const parsed = parseMacosFseventsBytes(block);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;

  expect(parsed.value.metadata.non_utf8_path_count).toBe(40);
  expect(parsed.value.metadata.diagnostics).toHaveLength(
    FSEVENTS_INLINE_DIAGNOSTIC_LIMIT,
  );
  expect(parsed.value.metadata.omitted_diagnostics).toBe(
    40 - FSEVENTS_INLINE_DIAGNOSTIC_LIMIT,
  );
});

it("bounds inline block and event samples while accumulating whole-file totals", () => {
  const blocks = Array.from({ length: 34 }, (_, index) =>
    buildDlsBlock({
      version: "1SLD",
      records: [
        {
          pathBytes: `/p/${String(index)}a`,
          eventId: BigInt(index * 2 + 1),
          flags: 1,
        },
        {
          pathBytes: `/p/${String(index)}b`,
          eventId: BigInt(index * 2 + 2),
          flags: 1,
        },
      ],
    }),
  );
  const parsed = parseMacosFseventsBytes(Buffer.concat(blocks));
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;

  expect(parsed.value.metadata.block_count).toBe(34);
  expect(parsed.value.metadata.blocks).toHaveLength(
    FSEVENTS_INLINE_BLOCK_LIMIT,
  );
  expect(parsed.value.metadata.omitted_blocks).toBe(2);
  expect(parsed.value.metadata.record_count).toBe(68);
  expect(parsed.value.metadata.records).toHaveLength(
    FSEVENTS_INLINE_EVENT_LIMIT,
  );
  expect(parsed.value.metadata.omitted_records).toBe(36);
});

it("diagnoses truncated blocks and records without discarding earlier valid events", () => {
  const truncated = buildDlsBlock({
    version: "2SLD",
    records: [{ pathBytes: "/ok", eventId: 1n, flags: 1, nodeId: 1n }],
    extraBody: Buffer.from("/dangling"), // missing NUL and 20-byte trailer
    declaredSizeOverride: 256,
  });
  const parsed = parseMacosFseventsBytes(truncated);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;

  expect(parsed.value.metadata.record_count).toBe(1);
  expect(parsed.value.metadata.malformed_record_count).toBe(1);
  expect(parsed.value.metadata.blocks[0]?.truncated).toBe(true);
  expect(parsed.value.metadata.diagnostics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ reason: "truncated-block" }),
      expect.objectContaining({ reason: "unterminated-path" }),
    ]),
  );
});

it("rejects foreign headers, undersized stream headers, corrupt gzip, and over-limit payloads", async () => {
  expect(parseMacosFseventsBytes(Buffer.from("NOTDLS012345"))).toEqual({
    ok: false,
    error: {
      kind: "format",
      message: expect.stringContaining("1SLD, 2SLD, 3SLD"),
    },
  });
  expect(parseMacosFseventsBytes(Buffer.from("1SLD1234"))).toEqual({
    ok: false,
    error: {
      kind: "format",
      message: expect.stringContaining("shorter than"),
    },
  });
  expect(
    parseMacosFseventsBytes(
      buildDlsBlock({ version: "1SLD", declaredSizeOverride: 4 }),
    ),
  ).toEqual({
    ok: false,
    error: {
      kind: "format",
      message: expect.stringContaining("smaller than"),
    },
  });
  expect(
    parseMacosFseventsBytes(
      Buffer.from([0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0, 0, 3, 0xff]),
    ),
  ).toEqual({
    ok: false,
    error: {
      kind: "format",
      message: expect.stringContaining("gzip decompression failed"),
    },
  });

  const bomb = gzipSync(Buffer.alloc(FSEVENTS_MAX_DECOMPRESSED_BYTES + 1024));
  expect(parseMacosFseventsBytes(bomb)).toEqual({
    ok: false,
    error: {
      kind: "limit",
      limitKind: "decompressed-bytes",
      limitBytes: FSEVENTS_MAX_DECOMPRESSED_BYTES,
      boundary: "capacity",
      message: expect.stringContaining("decompressed stream exceeds"),
    },
  });

  const oversizedSample = buildDlsBlock({
    version: "2SLD",
    records: [
      {
        pathBytes: Buffer.alloc(FSEVENTS_MAX_INLINE_PATH_BYTES + 1, 0x61),
        eventId: 1n,
        flags: 1,
        nodeId: 1n,
      },
    ],
  });
  expect(parseMacosFseventsBytes(oversizedSample)).toEqual({
    ok: false,
    error: {
      kind: "limit",
      limitKind: "sample-path-bytes",
      limitBytes: FSEVENTS_MAX_INLINE_PATH_BYTES,
      boundary: "capacity",
      message: expect.stringContaining("expansion allowance"),
    },
  });

  const oversizedRaw = Buffer.alloc(FSEVENTS_MAX_FILE_BYTES + 1);
  expect(parseMacosFseventsBytes(oversizedRaw)).toEqual({
    ok: false,
    error: {
      kind: "limit",
      limitKind: "input-bytes",
      limitBytes: FSEVENTS_MAX_FILE_BYTES,
      boundary: "file-size",
      message: expect.stringContaining("maximum"),
    },
  });

  const limitReader = new MacosFseventsArtifactReader(
    await writeStoreFile("oversized-sample", gzipSync(oversizedSample)),
  );
  await expect(async () => {
    for await (const _ of limitReader.entries()) {
      // exhausted by limit failure
    }
  }).rejects.toMatchObject({
    reason: "limit",
    boundary: "capacity",
    fixedAllowance: {
      kind: "parser",
      limit: FSEVENTS_MAX_INLINE_PATH_BYTES,
      unit: "bytes",
    },
  });
  await limitReader.close();

  const path = await writeStoreFile(
    "bad-fsevents",
    Buffer.from("NOTDLS012345"),
  );
  const reader = new MacosFseventsArtifactReader(path);
  await expect(async () => {
    for await (const _ of reader.entries()) {
      // exhausted by failure
    }
  }).rejects.toMatchObject({
    reason: "malformed",
    parseFailure: { kind: "malformed", format: "macos-fsevents" },
  });
  await expect(
    reader.open({
      path: "entry",
      kind: "file",
      declaredSize: 0,
      compressedSize: null,
      executable: false,
      encrypted: false,
      byteOffset: 0,
      byteLength: 0,
      declaredIntegrity: null,
      unpacked: false,
      limitations: [],
      adapterKey: "entry",
    }),
  ).rejects.toMatchObject({ reason: "unavailable" });
  await reader.close();
});
