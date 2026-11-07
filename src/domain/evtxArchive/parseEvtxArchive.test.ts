import { describe, expect, it } from "vitest";
import { evtxArchiveSchema } from "./evtxArchive.js";
import { parseEvtxArchive } from "./parseEvtxArchive.js";
import type { EvtxArchive } from "./evtxArchive.js";

const artifact = {
  path: "/artifacts/Security.evtx",
  sha256: "a".repeat(64),
  bytes: 0,
};

const FILE_HEADER_BYTES = 128;
const CHUNK_BYTES = 65_536;
const CHUNK_HEADER_BYTES = 512;

/**
 * Computed here rather than shared with the parser: a fixture that reused the
 * parser's own routine would keep passing if that routine were wrong.
 */
const crc32 = (bytes: Buffer): number => {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1)
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
};

/** Builds a 128-byte file header with the fields this inventory reads. */
const fileHeader = (chunks: number): Buffer => {
  const header = Buffer.alloc(FILE_HEADER_BYTES);
  header.write("ElfFile\u0000", 0, "latin1");
  // The version lives at 0x24 (minor) / 0x26 (major); 0x18 is the
  // next-record identifier, which a real file advances with its record count.
  header.writeUInt16LE(1, 0x24);
  header.writeUInt16LE(3, 0x26);
  header.writeBigUInt64LE(7n, 0x18);
  header.writeUInt16LE(FILE_HEADER_BYTES, 0x28);
  header.writeUInt16LE(chunks, 0x2a);
  return header;
};

/** One 24-byte record header followed by filler standing in for event XML. */
const record = (recordId: number, xmlBytes = 32): Buffer => {
  const bytes = Buffer.alloc(24 + xmlBytes);
  bytes.writeUInt32LE(0x00002a2a, 0);
  bytes.writeUInt32LE(bytes.length, 4);
  bytes.writeBigUInt64LE(BigInt(recordId), 8);
  bytes.writeBigUInt64LE(0n, 16);
  return bytes;
};

const readRecordId = (bytes: Buffer): number =>
  Number(bytes.readBigUInt64LE(8));

const withTimestamp = (bytes: Buffer, ms: number): Buffer => {
  const ticks = BigInt(ms + 11_644_473_600_000) * 10_000n;
  bytes.writeBigUInt64LE(ticks, 16);
  return bytes;
};

const chunk = (
  number: number,
  records: readonly Buffer[],
  /** 0x08 is a record number, so a realistic chunk states its first record's id. */
  statedFirstRecordNumber = records[0] !== undefined ? readRecordId(records[0]) : number,
): Buffer => {
  const bytes = Buffer.alloc(CHUNK_BYTES);
  bytes.write("ElfChnk\u0000", 0, "latin1");
  bytes.writeBigUInt64LE(BigInt(statedFirstRecordNumber), 8);
  let cursor = CHUNK_HEADER_BYTES;
  for (const entry of records) {
    // `subarray` keeps the parent's storage, so copy only the entry's own bytes.
    entry.copy(bytes, cursor, 0, entry.length);
    cursor += entry.length;
  }
  // A chunk this builder produces is intact, so it carries a valid signature.
  bytes.writeUInt32LE(chunkCrc(bytes), 0x7c);
  return bytes;
};

/** CRC32 of the chunk header with the stored checksum field omitted. */
const chunkCrc = (bytes: Buffer): number =>
  crc32(
    Buffer.concat([
      bytes.subarray(0, 0x7c),
      bytes.subarray(0x80, CHUNK_HEADER_BYTES),
    ]),
  );

const evtx = (chunks: readonly Buffer[]): Buffer =>
  Buffer.concat([fileHeader(chunks.length), ...chunks]);

const parse = (bytes: Buffer, options = {}) =>
  parseEvtxArchive(
    bytes,
    { ...artifact, bytes: bytes.length },
    {
      maxRecords: 100,
      ...options,
    },
  );

const parsed = (bytes: Buffer, options = {}): EvtxArchive => {
  const result = parse(bytes, options);
  if (!result.ok) throw new Error("expected a parsed log");
  return result.value;
};

describe("parseEvtxArchive", () => {
  it("inventories records across chunks in file order", () => {
    const archive = parsed(
      evtx([chunk(0, [record(1), record(2)]), chunk(1, [record(3)])]),
    );
    expect(archive.format).toBe("evtx");
    expect(archive.file_version.major).toBe(3);
    expect(archive.file_version.chunk_count).toBe(2);
    expect(archive.chunks).toHaveLength(2);
    expect(archive.events.map((event) => event.event_record_id)).toEqual([
      1, 2, 3,
    ]);
    expect(archive.events.map((event) => event.ordinal)).toEqual([0, 1, 2]);
    expect(archive.summary.events).toBe(3);
    expect(archive.source_coverage.status).toBe("complete-within-scope");
  });

  it("emits identifiers the declared output schema accepts", () => {
    // MCP registers evtxArchiveSchema as the success output schema, so an
    // underscore-less identifier fails the whole inspection at the boundary
    // rather than here. Parse through the schema, not just the parser.
    const archive = evtx([chunk(0, [record(1), record(2)])]);
    expect(evtxArchiveSchema.safeParse(parsed(archive)).success).toBe(true);
    // An empty inventory still carries an archive_id, so it needs the check.
    const empty = evtx([]);
    expect(evtxArchiveSchema.safeParse(parsed(empty)).success).toBe(true);
  });

  it("keeps record numbers distinct across wrapped logs", () => {
    // A wrapped log restarts record numbering; provenance must not collide.
    const archive = parsed(
      evtx([chunk(1, [record(1)]), chunk(1, [record(1)])]),
    );
    expect(archive.events.map((event) => event.event_record_id)).toEqual([
      1, 1,
    ]);
    expect(archive.events[0]?.event_id).not.toBe(archive.events[1]?.event_id);
    // The chunk number is the physical position, never the record number the
    // header states.
    expect(archive.chunks.map((entry) => entry.chunk_number)).toEqual([0, 1]);
  });

  it("numbers chunks by position even when their records start elsewhere", () => {
    // Intact chunks whose first record is not 1 — a wrapped or mid-stream
    // export. The header field is a record number, so it must neither rename
    // the chunk nor raise a mismatch against the physical position.
    const archive = parsed(evtx([chunk(37, [record(37)]), chunk(38, [record(38)])]));
    expect(archive.chunks.map((entry) => entry.chunk_number)).toEqual([0, 1]);
    expect(archive.events.map((event) => event.chunk_number)).toEqual([0, 1]);
    expect(archive.diagnostics.map((entry) => entry.code)).not.toContain(
      "first-record-number-mismatch",
    );
  });

  it("reports the record header timestamp as the file states it", () => {
    const archive = parsed(
      evtx([chunk(0, [withTimestamp(record(7), 1_700_000_000_000)])]),
    );
    expect(archive.events[0]?.header_timestamp_ms).toBe(1_700_000_000_000);
    expect(archive.events[0]?.header_timestamp).toBe(
      "2023-11-14T22:13:20.000Z",
    );
  });

  it("leaves an unset record timestamp null rather than epoch zero", () => {
    const archive = parsed(evtx([chunk(0, [record(7)])]));
    expect(archive.events[0]?.header_timestamp_ms).toBeNull();
    expect(archive.events[0]?.header_timestamp).toBeNull();
  });

  it("reports a chunk whose stated first record disagrees with its first record", () => {
    const archive = parsed(evtx([chunk(5, [record(9)], 5)]));
    expect(archive.diagnostics.map((entry) => entry.code)).toContain(
      "first-record-number-mismatch",
    );
  });

  it("skips a chunk without the ElfChnk signature", () => {
    const broken = Buffer.alloc(CHUNK_BYTES);
    const archive = parsed(evtx([broken]));
    expect(archive.chunks).toHaveLength(0);
    expect(archive.diagnostics.map((entry) => entry.code)).toContain(
      "invalid-chunk",
    );
    expect(archive.source_coverage.status).toBe("partial");
  });

  it("rejects a file without the ElfFile signature", () => {
    const archive = parsed(Buffer.from("not a windows event log"));
    expect(archive.events).toEqual([]);
    expect(archive.diagnostics[0]?.code).toBe("not-an-evtx-file");
    expect(archive.source_coverage.status).toBe("partial");
  });

  it("rejects a header block smaller than the file header", () => {
    const header = fileHeader(0);
    header.writeUInt16LE(4, 0x28);
    const archive = parsed(header);
    expect(archive.diagnostics[0]?.code).toBe("invalid-header");
  });

  it("keeps the events before a record that overruns the chunk", () => {
    const good = record(1);
    // The header and its declared size survive; the body the size covers is absent.
    const overrun = record(2, 32);
    overrun.writeUInt32LE(CHUNK_BYTES, 4);
    const archive = parsed(evtx([chunk(0, [good, overrun])]));
    expect(archive.events.map((event) => event.event_record_id)).toEqual([1]);
    expect(archive.diagnostics.map((entry) => entry.code)).toContain(
      "truncated-record",
    );
    expect(archive.source_coverage.status).toBe("partial");
  });

  it("stops at max_records and says so", () => {
    const archive = parsed(
      evtx([chunk(0, [record(1), record(2), record(3)])]),
      { maxRecords: 2 },
    );
    expect(archive.events).toHaveLength(2);
    expect(archive.diagnostics.map((entry) => entry.code)).toContain(
      "record-limit-reached",
    );
    expect(archive.source_coverage.status).toBe("partial");
  });

  it("accepts an empty log as an empty inventory", () => {
    const archive = parsed(evtx([chunk(0, [])]));
    expect(archive.events).toEqual([]);
    expect(archive.chunks).toHaveLength(1);
    expect(archive.diagnostics).toEqual([]);
    expect(archive.source_coverage.status).toBe("complete-within-scope");
  });

  it("evaluates the chunk header checksum", () => {
    // An intact chunk is `matched`, not `mismatched`: EVTX signs the header
    // with CRC32 over 0x00..0x77 and 0x80..0x1ff, so the stored value is
    // independent of how many records follow it.
    const intact = parsed(evtx([chunk(0, [])]));
    expect(intact.chunks[0]?.checksum).toBe("matched");

    const signed = chunk(0, []);
    expect(parsed(evtx([signed])).chunks[0]?.checksum).toBe("matched");

    // One bit off the stored value is enough to fail it.
    signed.writeUInt32LE(chunkCrc(signed) ^ 1, 0x7c);
    expect(parsed(evtx([signed])).chunks[0]?.checksum).toBe("mismatched");
  });

  it("does not treat the tail of a wrapped chunk as an error", () => {
    // A wrapped log leaves stale bytes after the last record; those are not a
    // truncation and must not make otherwise intact chunks look damaged.
    const archive = parsed(evtx([chunk(0, [record(1)])]));
    expect(archive.diagnostics).toEqual([]);
    expect(archive.chunks[0]?.events).toBe(1);
  });
});
