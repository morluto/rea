import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { AuditdLogArtifactReader } from "./AuditdLogArtifactReader.js";
import { ArtifactReaderFailure } from "../resources/ArtifactReader.js";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";

const record = (
  type: string,
  seconds: number,
  millis: number,
  serial: number,
  body: string,
): string =>
  `type=${type} msg=audit(${String(seconds)}.${String(millis)}:${String(serial)}): ${body}`;

const writeLog = async (name: string, text: string): Promise<string> => {
  const directory = await createTestTempDirectory("rea-auditd-");
  const path = join(directory, name);
  await writeFile(path, text);
  return path;
};

const metadataOf = async (text: string) => {
  const reader = new AuditdLogArtifactReader(await writeLog("audit.log", text));
  try {
    for await (const _entry of reader.entries()) {
      // The log declares no members; the root occurrence is the inventory.
    }
    const metadata = reader.formatMetadata();
    if (metadata?.kind !== "auditd-log")
      throw new Error("Expected auditd-log metadata");
    return metadata;
  } finally {
    await reader.close();
  }
};

const EXECUTION_EVENT = [
  record(
    "SYSCALL",
    1700000000,
    123,
    1000,
    "arch=c000003e syscall=59 success=yes",
  ),
  record("EXECVE", 1700000000, 123, 1000, "argc=1 a0=whoami"),
  record("PATH", 1700000000, 123, 1000, 'item=0 name="/usr/bin/whoami"'),
  record("CWD", 1700000000, 123, 1000, 'cwd="/root"'),
  record("PROCTITLE", 1700000000, 123, 1000, "7072696D617279"),
].join("\n");

it("joins records sharing an audit event identity into one event", async () => {
  const metadata = await metadataOf(`${EXECUTION_EVENT}\n`);
  expect(metadata.record_count).toBe(5);
  expect(metadata.event_count).toBe(1);
  expect(metadata.events).toHaveLength(1);
  const [event] = metadata.events;
  expect(event?.event_id).toBe("1700000000.123:1000");
  expect(event?.event_seconds).toBe(1700000000);
  expect(event?.event_millis).toBe(123);
  expect(event?.serial).toBe(1000);
  expect(event?.record_count).toBe(5);
  expect(event?.first_line).toBe(1);
  expect(event?.last_line).toBe(5);
  expect(event?.record_types).toEqual([
    { type: "CWD", count: 1 },
    { type: "EXECVE", count: 1 },
    { type: "PATH", count: 1 },
    { type: "PROCTITLE", count: 1 },
    { type: "SYSCALL", count: 1 },
  ]);
  expect(metadata.event_type_counts).toContainEqual({
    type: "SYSCALL",
    count: 1,
  });
});

it("keeps events apart across different serials at the same timestamp", async () => {
  const metadata = await metadataOf(
    [
      record("SYSCALL", 1700000000, 123, 1000, "success=yes"),
      record("SYSCALL", 1700000000, 123, 1001, "success=yes"),
      record("SYSCALL", 1700000000, 124, 1000, "success=yes"),
    ].join("\n"),
  );
  expect(metadata.event_count).toBe(3);
  expect(metadata.events.map((event) => event.event_id)).toEqual([
    "1700000000.123:1000",
    "1700000000.123:1001",
    "1700000000.124:1000",
  ]);
});

it("counts a record type repeated for one event without dropping it", async () => {
  const metadata = await metadataOf(
    [
      record("PATH", 1700000000, 123, 1000, "item=0"),
      record("PATH", 1700000000, 123, 1000, "item=1"),
      record("PATH", 1700000000, 123, 1000, "item=2"),
      record("PATH", 1700000000, 123, 1000, "item=1"),
    ].join("\n"),
  );
  const [event] = metadata.events;
  expect(event?.record_count).toBe(4);
  expect(event?.duplicate_record_count).toBe(1);
  expect(event?.record_types).toEqual([{ type: "PATH", count: 3 }]);
  expect(metadata.duplicate_record_count).toBe(1);
});

it("keeps every path of a multi-path event apart and counted", async () => {
  const metadata = await metadataOf(
    [
      record(
        "SYSCALL",
        1700000000,
        123,
        1000,
        "items=2 syscall=82 success=yes",
      ),
      record("PATH", 1700000000, 123, 1000, 'item=0 name="/tmp/from"'),
      record("PATH", 1700000000, 123, 1000, 'item=1 name="/tmp/to"'),
    ].join("\n"),
  );
  const [event] = metadata.events;
  expect(event?.record_count).toBe(3);
  expect(event?.duplicate_record_count).toBe(0);
  expect(metadata.duplicate_record_count).toBe(0);
  expect(event?.record_types).toEqual([
    { type: "PATH", count: 2 },
    { type: "SYSCALL", count: 1 },
  ]);
});

it("reports interleaved and out-of-order records instead of reordering them", async () => {
  const metadata = await metadataOf(
    [
      record("SYSCALL", 1700000000, 200, 4, "success=yes"),
      record("SYSCALL", 1700000000, 100, 3, "success=no"),
      record("EXECVE", 1700000000, 200, 4, "argc=1"),
    ].join("\n"),
  );
  expect(metadata.event_count).toBe(2);
  expect(metadata.events.map((event) => event.event_id)).toEqual([
    "1700000000.200:4",
    "1700000000.100:3",
  ]);
  expect(metadata.events[0]?.interleaved).toBe(true);
  expect(metadata.events[1]?.interleaved).toBe(false);
  expect(metadata.interleaved_event_count).toBe(1);
  expect(metadata.out_of_order_record_count).toBe(1);
});

it("keeps malformed lines as diagnostics without dropping valid events", async () => {
  const metadata = await metadataOf(
    [
      record("SYSCALL", 1700000000, 123, 1000, "success=yes"),
      "this line is not an auditd record",
      "type=EXECVE msg=audit(broken): argc=1",
    ].join("\n"),
  );
  expect(metadata.record_count).toBe(1);
  expect(metadata.event_count).toBe(1);
  expect(metadata.malformed_line_count).toBe(2);
  expect(metadata.malformed_lines).toHaveLength(2);
  expect(metadata.malformed_lines[0]?.line).toBe(2);
  expect(metadata.malformed_lines[0]?.excerpt).toBe(
    "this line is not an auditd record",
  );
});

it("names a node= prefix record as the same event as its plain peers", async () => {
  const metadata = await metadataOf(
    [
      record("SYSCALL", 1700000000, 123, 1000, "success=yes"),
      `node=host1 ${record("EXECVE", 1700000000, 123, 1000, "argc=1")}`,
    ].join("\n"),
  );
  expect(metadata.event_count).toBe(1);
  expect(metadata.events[0]?.record_count).toBe(2);
});

it("records trailing bytes when the last line has no newline", async () => {
  const metadata = await metadataOf(
    `line one\n${record("SYSCALL", 1700000000, 123, 1000, "success=yes")}`,
  );
  expect(metadata.line_count).toBe(2);
  expect(metadata.trailing_bytes).toBeGreaterThan(0);
  expect(metadata.event_count).toBe(1);
});

it("samples a bounded window of events while totals cover the whole file", async () => {
  const lines = Array.from({ length: 40 }, (_unused, index) =>
    record("SYSCALL", 1700000000, 100, 1000 + index, "success=yes"),
  );
  const metadata = await metadataOf(`${lines.join("\n")}\n`);
  expect(metadata.event_count).toBe(40);
  expect(metadata.events).toHaveLength(32);
  expect(metadata.omitted_events).toBe(8);
});

it("refuses a file with no auditd record as malformed", async () => {
  const reader = new AuditdLogArtifactReader(
    await writeLog("notes.txt", "just some text\nand more text\n"),
  );
  await expect(async () => {
    for await (const _entry of reader.entries()) {
      // No members; the parse itself must fail.
    }
  }).rejects.toBeInstanceOf(ArtifactReaderFailure);
  await reader.close();
});

it("reports no members to open", async () => {
  const reader = new AuditdLogArtifactReader(
    await writeLog("audit.log", `${EXECUTION_EVENT}\n`),
  );
  await expect(
    reader.open({
      path: "audit.log",
      kind: "file",
      declaredSize: null,
      compressedSize: null,
      executable: false,
      encrypted: false,
      byteOffset: null,
      declaredIntegrity: null,
      unpacked: false,
      limitations: [],
      adapterKey: "root",
    }),
  ).rejects.toBeInstanceOf(ArtifactReaderFailure);
  await reader.close();
});
