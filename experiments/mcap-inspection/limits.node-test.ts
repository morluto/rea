import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { TempBuffer } from "@mcap/core";
import { recording } from "./fixtures.ts";
import { inspectSummary } from "./summary.ts";
import {
  BoundedReadable,
  boundedJson,
  OUTPUT_BYTES,
  READ_BYTES,
} from "./limits.ts";

await test("refuses oversized declared header length before issuing the large read", async () => {
  const prefix = Buffer.from(await recording()).subarray(0, 17);
  prefix.writeBigUInt64LE(BigInt(READ_BYTES + 1), 9);
  const requests: bigint[] = [];
  const result = await inspectSummary({
    size: async () => BigInt(READ_BYTES * 2),
    read: async (_offset, size) => {
      requests.push(size);
      assert.equal(size, 17n);
      return prefix;
    },
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.kind, "limit");
  assert.deepEqual(requests, [17n]);
});

await test("refuses invalid ranges and retains only bytes returned by short reads", async () => {
  const readable = new BoundedReadable(new TempBuffer(Buffer.alloc(4)));
  for (const [offset, length] of [
    [-1n, 1n],
    [0n, -1n],
    [3n, 2n],
  ]) {
    assert.ok(offset !== undefined && length !== undefined);
    await assert.rejects(readable.read(offset, length), /outside the file/);
  }
  const short = new BoundedReadable({
    size: async () => 4n,
    read: async () => Buffer.alloc(1),
  });
  await assert.rejects(short.read(0n, 4n), /ended before/);
  assert.deepEqual(short.reads, [
    {
      offset: "0",
      byte_length: "1",
      sha256: createHash("sha256").update(Buffer.alloc(1)).digest("hex"),
      requested_byte_length: "4",
      complete: false,
    },
  ]);
  const empty = new BoundedReadable({
    size: async () => 4n,
    read: async () => Buffer.alloc(0),
  });
  await assert.rejects(empty.read(0n, 4n), /ended before/);
  assert.deepEqual(empty.reads, []);
});

await test("applies a cumulative read limit even when every individual read fits", async () => {
  const readable = new BoundedReadable(
    new TempBuffer(Buffer.alloc(READ_BYTES)),
  );
  await readable.read(0n, BigInt(READ_BYTES));
  await assert.rejects(readable.read(0n, 1n), /Cumulative reads/);
});

await test("accounts for JSON escaping and base64 expansion", async () => {
  assert.throws(
    () => boundedJson({ text: "\u0000".repeat(OUTPUT_BYTES / 6) }),
    /JSON output exceeds/,
  );
  const input = new TempBuffer(await recording({}, Buffer.alloc(OUTPUT_BYTES)));
  const summary = await inspectSummary(input);
  if (!summary.ok) throw summary.error;
  const selected = await inspectSummary(input, 1);
  assert.equal(selected.ok, false);
  if (!selected.ok) {
    assert.equal(selected.error.kind, "limit");
    assert.match(selected.error.message, /base64/);
    assert.equal(selected.error.read_ranges.length, 4);
  }
});
