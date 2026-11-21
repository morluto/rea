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
  /** Chunk record identifier, independent of its record number. */
  statedFirstRecordNumber = records[0] !== undefined
    ? readRecordId(records[0])
    : number,
): Buffer => {
  const bytes = Buffer.alloc(CHUNK_BYTES);
  bytes.write("ElfChnk\u0000", 0, "latin1");
  bytes.writeBigUInt64LE(BigInt(number), 8);
  bytes.writeBigUInt64LE(BigInt(statedFirstRecordNumber), 0x18);
  let cursor = CHUNK_HEADER_BYTES;
  for (const entry of records) {
    bytes.writeUInt32LE(cursor, 0x2c);
    // `subarray` keeps the parent's storage, so copy only the entry's own bytes.
    entry.copy(bytes, cursor, 0, entry.length);
    cursor += entry.length;
  }
  // 0x30 is the free-space offset: a real writer maintains it, and the parser
  // uses it to stop before stale bytes. Leave it at 0 and every chunk would
  // read as fully used.
  bytes.writeUInt32LE(cursor, 0x30);
  // A chunk this builder produces is intact, so it carries a valid signature.
  bytes.writeUInt32LE(chunkCrc(bytes), 0x7c);
  return bytes;
};

/** CRC32 of the chunk header with the stored checksum field omitted. */
const chunkCrc = (bytes: Buffer): number =>
  crc32(
    Buffer.concat([
      bytes.subarray(0, 0x78),
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
    const archive = parsed(
      evtx([chunk(37, [record(37)]), chunk(38, [record(38)])]),
    );
    expect(archive.chunks.map((entry) => entry.chunk_number)).toEqual([0, 1]);
    expect(archive.events.map((event) => event.chunk_number)).toEqual([0, 1]);
    expect(archive.diagnostics.map((entry) => entry.code)).not.toContain(
      "first-record-id-mismatch",
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

  it("takes the endpoints from the first and last record, not from the first value", () => {
    // An unset timestamp on either end must stay null instead of borrowing an
    // inner record's value.
    const archive = parsed(
      evtx([
        chunk(1, [
          record(1),
          withTimestamp(record(2), 1_700_000_000_000),
          record(3),
        ]),
      ]),
    );
    expect(archive.chunks[0]?.first_timestamp_ms).toBeNull();
    expect(archive.chunks[0]?.last_timestamp_ms).toBeNull();

    const head = parsed(
      evtx([chunk(1, [withTimestamp(record(1), 1_700_000_000_000)])]),
    );
    expect(head.chunks[0]?.first_timestamp_ms).toBe(1_700_000_000_000);
    expect(head.chunks[0]?.last_timestamp_ms).toBe(1_700_000_000_000);
  });

  it("preserves an unrepresentable first record identifier as unknown", () => {
    const first = record(1);
    first.writeBigUInt64LE(BigInt(Number.MAX_SAFE_INTEGER) + 1n, 8);
    const archive = parsed(evtx([chunk(0, [first, record(2)], 0)]));
    expect(archive.events.map((event) => event.event_record_id)).toEqual([
      null,
      2,
    ]);
    expect(archive.chunks[0]?.first_event_record_id).toBeNull();
    expect(archive.chunks[0]?.last_event_record_id).toBe(2);
  });

  it("accepts chunk timestamps from before 1970", () => {
    // `timestampMs` admits them as negative Unix milliseconds, so the output
    // schema must not reject the chunk fields it feeds.
    const archive = parsed(
      evtx([chunk(1, [withTimestamp(record(1), -100_000_000_000)])]),
    );
    expect(archive.chunks[0]?.first_timestamp_ms).toBe(-100_000_000_000);
    expect(evtxArchiveSchema.safeParse(archive).success).toBe(true);
  });

  it("leaves an unset record timestamp null rather than epoch zero", () => {
    const archive = parsed(evtx([chunk(0, [record(7)])]));
    expect(archive.events[0]?.header_timestamp_ms).toBeNull();
    expect(archive.events[0]?.header_timestamp).toBeNull();
  });

  it("reports a chunk whose stated first record disagrees with its first record", () => {
    const archive = parsed(evtx([chunk(5, [record(9)], 5)]));
    expect(archive.diagnostics.map((entry) => entry.code)).toContain(
      "first-record-id-mismatch",
    );
  });

  it("does not compare a record number to a record identifier", () => {
    const archive = parsed(evtx([chunk(5, [record(9)], 9)]));
    expect(archive.diagnostics.map((entry) => entry.code)).not.toContain(
      "first-record-id-mismatch",
    );
  });
});

describe("parseEvtxArchive damaged input", () => {
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

  it("reports an incomplete final chunk instead of claiming complete coverage", () => {
    const archive = parsed(
      Buffer.concat([evtx([chunk(0, [record(1)])]), Buffer.alloc(200)]),
    );
    expect(archive.events.map((event) => event.event_record_id)).toEqual([1]);
    expect(archive.diagnostics.map((entry) => entry.code)).toContain(
      "invalid-chunk",
    );
    expect(archive.source_coverage.status).toBe("partial");
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
});

describe("parseEvtxArchive chunk boundaries", () => {
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
});

describe("parseEvtxArchive chunk headers", () => {
  it("checks the documented header bytes against an independently computed CRC", () => {
    const signed = chunk(0, []);
    // Python zlib.crc32 of 0x00..0x77 + 0x80..0x1ff for this header.
    signed.writeUInt32LE(0x9c77546c, 0x7c);
    signed.writeUInt32LE(0x12345678, 0x78);
    expect(parsed(evtx([signed])).chunks[0]?.checksum).toBe("matched");
    signed[0x40] = 1;
    const mismatched = parsed(evtx([signed]));
    expect(mismatched.chunks[0]?.checksum).toBe("mismatched");
    // The summary view omits `chunks`; without a diagnostic a reader would
    // see an empty diagnostic list and complete coverage over a chunk whose
    // stored checksum does not describe its bytes.
    expect(mismatched.diagnostics.map((entry) => entry.code)).toContain(
      "chunk-checksum-mismatch",
    );
    expect(mismatched.source_coverage.status).toBe("partial");
  });

  it("does not invent live records when the free-space offset is invalid", () => {
    const broken = chunk(1, [record(7)]);
    broken.writeUInt32LE(0, 0x30);
    const archive = parsed(evtx([broken]));
    expect(archive.events).toEqual([]);
    expect(archive.diagnostics.map((entry) => entry.code)).toContain(
      "invalid-chunk",
    );
    expect(archive.source_coverage.status).toBe("partial");
  });

  it("ignores stale records after the declared last record", () => {
    const padded = chunk(1, [record(7)]);
    const end = padded.readUInt32LE(0x30);
    const stale = record(8);
    stale.copy(padded, end);
    padded.writeUInt32LE(end + stale.length, 0x30);
    // Stale records are not a header change, so re-sign the header this edit
    // invalidated; otherwise the chunk also reports a checksum mismatch.
    padded.writeUInt32LE(chunkCrc(padded), 0x7c);
    const archive = parsed(evtx([padded]));
    expect(archive.events.map((event) => event.event_record_id)).toEqual([7]);
    expect(archive.source_coverage.status).toBe("complete-within-scope");
  });
  it("reports invalid and unreachable last-record offsets", () => {
    const invalid = chunk(1, [record(7)]);
    invalid.writeUInt32LE(100, 0x2c);
    const invalidResult = parsed(evtx([invalid]));
    expect(invalidResult.events).toEqual([]);
    expect(invalidResult.source_coverage.status).toBe("partial");
    const unreachable = chunk(1, [record(7), record(8)]);
    unreachable.writeUInt32LE(CHUNK_HEADER_BYTES + 1, 0x2c);
    const unreachableResult = parsed(evtx([unreachable]));
    expect(unreachableResult.events).toEqual([]);
    expect(unreachableResult.source_coverage.status).toBe("partial");
  });

  it("keeps the readable prefix when a declared live record has bad magic", () => {
    const damaged = chunk(1, [record(7), record(8)]);
    damaged.writeUInt32LE(0, damaged.readUInt32LE(0x2c));
    const archive = parsed(evtx([damaged]));
    expect(archive.events.map((event) => event.event_record_id)).toEqual([7]);
    expect(archive.diagnostics.map((entry) => entry.code)).toContain(
      "truncated-record",
    );
    expect(archive.source_coverage.status).toBe("partial");
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
    signed.writeUInt32LE((chunkCrc(signed) ^ 1) >>> 0, 0x7c);
    expect(parsed(evtx([signed])).chunks[0]?.checksum).toBe("mismatched");
  });

  it("does not inventory stale bytes after the chunk's free-space offset", () => {
    // A wrapped chunk discards records without zeroing them. The bytes past
    // 0x30 are unused, so a record header that survives there is not a record.
    const wrapped = chunk(1, [record(7)]);
    record(8).copy(wrapped, wrapped.readUInt32LE(0x30));
    const archive = parsed(evtx([wrapped]));
    expect(archive.chunks[0]?.events).toBe(1);
    expect(archive.events.map((event) => event.event_record_id)).toEqual([7]);
  });

  it("does not treat the tail of a wrapped chunk as an error", () => {
    // A wrapped log leaves stale bytes after the last record; those are not a
    // truncation and must not make otherwise intact chunks look damaged.
    const archive = parsed(evtx([chunk(0, [record(1)])]));
    expect(archive.diagnostics).toEqual([]);
    expect(archive.chunks[0]?.events).toBe(1);
  });
});
