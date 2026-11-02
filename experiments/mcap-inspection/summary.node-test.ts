import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { TempBuffer } from "@mcap/core";
import { recording, timestamp } from "./fixtures.ts";
import { inspectSummary } from "./summary.ts";

await test("reports declared facts without merging channels that share a topic", async () => {
  const result = await inspectSummary(new TempBuffer(await recording()));
  if (!result.ok) throw result.error;
  const report = result.value;
  assert.equal(report.header.library, "rea-mcap-test");
  assert.equal(report.declared_statistics?.message_count, "2");
  assert.equal(
    report.declared_statistics?.message_start_time_ns,
    String(timestamp),
  );
  assert.deepEqual(
    report.channels.map((c) => c.id),
    [0, 1],
  );
  assert.deepEqual(
    report.channels.map((c) => c.topic),
    ["/sensor", "/sensor"],
  );
  assert.deepEqual(
    report.channels.map((c) => c.message_count),
    ["1", "1"],
  );
  assert.equal(report.coverage.data_section, "not_scanned");
  assert.equal(report.coverage.whole_file_validity, "not_established");
  assert.equal(report.schemas[0]?.data_base64, null);
});

await test("selected schema bytes round-trip without UTF-8 replacement", async () => {
  const data = Buffer.from([0xff, 0x00, 0x80, 0x41]);
  const result = await inspectSummary(
    new TempBuffer(await recording({}, data)),
    1,
  );
  if (!result.ok) throw result.error;
  assert.equal(result.value.schemas[0]?.data_base64, data.toString("base64"));
  assert.equal(
    result.value.schemas[0]?.sha256,
    createHash("sha256").update(data).digest("hex"),
  );
});

await test("missing statistics remain unknown, not zero", async () => {
  const result = await inspectSummary(
    new TempBuffer(await recording({ useStatistics: false })),
  );
  if (!result.ok) throw result.error;
  assert.equal(result.value.declared_statistics, null);
  assert.deepEqual(
    result.value.channels.map((c) => c.message_count),
    [null, null],
  );
});

await test("schemas omitted from the summary remain unresolved", async () => {
  const bytes = await recording({ repeatSchemas: false });
  const result = await inspectSummary(new TempBuffer(bytes));
  if (!result.ok) throw result.error;
  assert.equal(result.value.schemas.length, 0);
  assert.deepEqual(
    result.value.channels.map((c) => c.schema_in_summary),
    [false, false],
  );
  const selected = await inspectSummary(new TempBuffer(bytes), 1);
  assert.equal(selected.ok, false);
  if (!selected.ok) assert.equal(selected.error.kind, "selection");
});

await test("chunk compression is reported without loading a decompressor", async () => {
  const result = await inspectSummary(
    new TempBuffer(
      await recording({
        compressChunk: (data) => ({
          compression: "fixture-unknown-codec",
          compressedData: data,
        }),
      }),
    ),
  );
  if (!result.ok) throw result.error;
  assert.equal(
    result.value.chunk_indexes[0]?.compression,
    "fixture-unknown-codec",
  );
  assert.equal(result.value.coverage.data_section, "not_scanned");
});

await test("a valid recording with no summary is explicitly unsupported", async () => {
  const bytes = await recording({
    useChunks: false,
    useStatistics: false,
    useSummaryOffsets: false,
    repeatChannels: false,
    repeatSchemas: false,
  });
  const result = await inspectSummary(new TempBuffer(bytes));
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.kind, "reader_rejected");
    assert.match(result.error.message, /not indexed/);
  }
});

await test("rejects malformed magic, truncated footer, and summary CRC corruption", async () => {
  const bytes = await recording();
  const magic = Buffer.from(bytes);
  magic[0] = 0;
  const crc = Buffer.from(bytes);
  crc.writeUInt8(crc.readUInt8(crc.length - 12) ^ 1, crc.length - 12);
  for (const input of [magic, bytes.subarray(0, bytes.length - 1), crc]) {
    const result = await inspectSummary(new TempBuffer(input));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.kind, "reader_rejected");
  }
});
