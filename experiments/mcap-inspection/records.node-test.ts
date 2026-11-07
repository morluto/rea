import assert from "node:assert/strict";
import { test } from "node:test";
import { McapByteReader, Opcode, parseRecord, TempBuffer } from "@mcap/core";
import { validateSummaryRecords } from "./records.ts";
import { inspectSummary } from "./summary.ts";
import { recording } from "./fixtures.ts";

await test("each SDK parse is restricted to its declared record boundary", () => {
  const bytes = Buffer.alloc(29);
  bytes[0] = Opcode.CHANNEL;
  bytes.writeBigUInt64LE(4n, 1);
  bytes.writeUInt32LE(4, 13);
  bytes.write("tail", 17);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const unbounded = parseRecord(new McapByteReader(view));
  assert.equal(unbounded?.type, "Channel");
  if (unbounded?.type === "Channel") assert.equal(unbounded.topic, "tail");
  assert.throws(() => validateSummaryRecords(bytes), /record boundary/);
});

await test("inspection rejects a Channel string crossing its frame after a complete length prefix", async () => {
  const bytes = await recording();
  const valid = await inspectSummary(new TempBuffer(bytes));
  if (!valid.ok) throw valid.error;
  assert.equal(valid.value.channels[0]?.topic, "/sensor");

  const footer = bytes.length - 37;
  const summaryStart = Number(bytes.readBigUInt64LE(footer + 9));
  assert.equal(bytes[summaryStart], Opcode.SCHEMA);
  const start =
    summaryStart + 9 + Number(bytes.readBigUInt64LE(summaryStart + 1));
  assert.equal(bytes[start], Opcode.CHANNEL);
  assert.equal(bytes.readUInt32LE(start + 13), 7);
  assert.equal(bytes.toString("utf8", start + 17, start + 24), "/sensor");
  // Record-relative ranges: length [13,17), string [17,24), frame [0,18).
  bytes.writeBigUInt64LE(9n, start + 1);
  bytes.writeUInt32LE(0, footer + 25);

  const result = await inspectSummary(new TempBuffer(bytes));
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.kind, "reader_rejected");
    assert.equal(
      result.error.message,
      `Invalid summary record boundary at byte ${start - summaryStart + 13}: String length 7 exceeds bounds of buffer`,
    );
    const read = result.error.read_ranges.at(-1);
    assert.equal(read?.offset, String(summaryStart - 13));
    assert.equal(read?.byte_length, String(footer - summaryStart + 13));
  }
});

await test("inspection rejects Schema data crossing its frame after a complete length prefix", async () => {
  const schemaData = Buffer.from([0xff, 0x00, 0x80, 0x41]);
  const bytes = await recording({}, schemaData);
  const valid = await inspectSummary(new TempBuffer(bytes), 1);
  if (!valid.ok) throw valid.error;
  assert.equal(
    valid.value.schemas[0]?.data_base64,
    schemaData.toString("base64"),
  );

  const footer = bytes.length - 37;
  const start = Number(bytes.readBigUInt64LE(footer + 9));
  assert.equal(bytes[start], Opcode.SCHEMA);
  assert.equal(bytes.readUInt32LE(start + 35), 4);
  assert.deepEqual(bytes.subarray(start + 39, start + 43), schemaData);
  // Record-relative ranges: length [35,39), data [39,43), frame [0,40).
  bytes.writeBigUInt64LE(31n, start + 1);
  bytes.writeUInt32LE(0, footer + 25);

  const result = await inspectSummary(new TempBuffer(bytes), 1);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.kind, "reader_rejected");
    assert.equal(
      result.error.message,
      "Invalid summary record boundary at byte 13: Schema data length 4 exceeds bounds of record",
    );
    const read = result.error.read_ranges.at(-1);
    assert.equal(read?.offset, String(start - 13));
    assert.equal(read?.byte_length, String(footer - start + 13));
  }
});

await test("inspection rejects a short summary frame and retains the read evidence", async () => {
  const bytes = await recording();
  const footer = bytes.length - 37;
  const start = Number(bytes.readBigUInt64LE(footer + 9));
  bytes.writeBigUInt64LE(0n, start + 1);
  bytes.writeUInt32LE(0, footer + 25);
  const result = await inspectSummary(new TempBuffer(bytes));
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.kind, "reader_rejected");
    assert.match(result.error.message, /record boundary/);
    assert.equal(result.error.read_ranges.length, 4);
  }
});
