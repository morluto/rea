import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { AuditdLogArtifactReader } from "./AuditdLogArtifactReader.js";
import { ArtifactReaderFailure } from "../resources/ArtifactReader.js";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";

const record = (
  type: string,
  seconds: number,
  millis: number | string,
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

it("counts an interleaved event whose later record is past the display sample", async () => {
  const lines = Array.from({ length: 32 }, (_, index) =>
    record("SYSCALL", 1700000000, 100, index + 1, "success=yes"),
  );
  lines.push(
    record("SYSCALL", 1700000000, 200, 40, "success=yes"),
    record("SYSCALL", 1700000000, 300, 41, "success=yes"),
    record("EXECVE", 1700000000, 200, 40, "argc=1"),
  );
  const metadata = await metadataOf(lines.join("\n"));
  expect(metadata.event_count).toBe(34);
  expect(metadata.events).toHaveLength(32);
  expect(metadata.omitted_events).toBe(2);
  expect(metadata.events.some((event) => event.interleaved)).toBe(false);
  expect(metadata.interleaved_event_count).toBe(1);
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

it("keeps the same event identity apart across different nodes", async () => {
  const metadata = await metadataOf(
    [
      record("SYSCALL", 1700000000, 123, 1000, "success=yes"),
      `node=host1 ${record("EXECVE", 1700000000, 123, 1000, "argc=1")}`,
      `node=host2 ${record("SYSCALL", 1700000000, 123, 1000, "success=yes")}`,
    ].join("\n"),
  );
  // An unqualified record and a node=host2 record share a timestamp and serial
  // but belong to different hosts, so they must not be joined.
  expect(metadata.event_count).toBe(3);
  expect(metadata.events.map((event) => event.node)).toEqual([
    null,
    "host1",
    "host2",
  ]);
  expect(metadata.events.every((event) => event.record_count === 1)).toBe(true);
  expect(metadata.duplicate_record_count).toBe(0);
});

it("pads every event timestamp millis to three digits", async () => {
  const metadata = await metadataOf(
    [
      record("SYSCALL", 1700000000, 7, 1000, "success=yes"),
      record("EXECVE", 1700000000, "050", 1001, "argc=1"),
    ].join("\n"),
  );
  expect(metadata.events.map((event) => event.event_id)).toEqual([
    "1700000000.007:1000",
    "1700000000.050:1001",
  ]);
});

it("treats split EXECVE records as continuations, not duplicates", async () => {
  const metadata = await metadataOf(
    [
      record("SYSCALL", 1700000000, 123, 1000, "items=0 syscall=59"),
      record("EXECVE", 1700000000, 123, 1000, "argc=3 a0=10 a1=20"),
      record("EXECVE", 1700000000, 123, 1000, "a2=30 a3=40"),
      record("EXECVE", 1700000000, 123, 1000, "a4=50"),
    ].join("\n"),
  );
  const [event] = metadata.events;
  expect(event?.duplicate_record_count).toBe(0);
  expect(event?.record_types).toEqual([
    { type: "EXECVE", count: 3 },
    { type: "SYSCALL", count: 1 },
  ]);
});

it("still counts a byte-identical record as a duplicate", async () => {
  const metadata = await metadataOf(
    [
      record("EXECVE", 1700000000, 123, 1000, "argc=1 a0=whoami"),
      record("EXECVE", 1700000000, 123, 1000, "argc=1 a0=whoami"),
    ].join("\n"),
  );
  expect(metadata.duplicate_record_count).toBe(1);
  expect(metadata.events[0]?.record_types).toEqual([
    { type: "EXECVE", count: 1 },
  ]);
});

const NON_UTF8 = Buffer.from([
  ...Buffer.from(record("USER", 1700000000, 123, 1000, "pid=1 msg=")),
  0x80,
  0x0a,
  ...Buffer.from(record("USER", 1700000000, 123, 1000, "pid=1 msg=")),
  0x81,
  0x0a,
]);

it("keeps records with distinct non-UTF-8 bodies apart", async () => {
  const directory = await createTestTempDirectory("rea-auditd-");
  const path = join(directory, "audit.log");
  await writeFile(path, NON_UTF8);
  const reader = new AuditdLogArtifactReader(path);
  try {
    for await (const _entry of reader.entries()) {
      // The log declares no members; the root occurrence is the inventory.
    }
    const metadata = reader.formatMetadata();
    if (metadata?.kind !== "auditd-log")
      throw new Error("Expected auditd-log metadata");
    const [event] = metadata.events;
    expect(event?.duplicate_record_count).toBe(0);
    expect(event?.record_types).toEqual([{ type: "USER", count: 2 }]);
  } finally {
    await reader.close();
  }
});

it("does not recount a multi-record event once it is past the retained window", async () => {
  const lines = Array.from({ length: 4096 }, (_unused, index) =>
    record("SYSCALL", 1700000000, 100, 1000 + index, "success=yes"),
  );
  lines.push(
    record("SYSCALL", 1700000000, 200, 5000, "success=yes"),
    record("EXECVE", 1700000000, 200, 5000, "argc=1 a0=whoami"),
    record("PATH", 1700000000, 200, 5000, 'item=0 name="/usr/bin/whoami"'),
  );
  const metadata = await metadataOf(`${lines.join("\n")}\n`);
  expect(metadata.event_count).toBe(4097);
  expect(metadata.omitted_events).toBe(4097 - 32);
  expect(metadata.event_count_lower_bound).toBe(true);
});

it("keeps a record whose opaque body holds a line-separator character", async () => {
  // The scanner splits on "\n" only, so a U+2028 in the body keeps the record
  // on one line while still exercising the separator `.` excludes from a regex.
  const metadata = await metadataOf(
    [
      record("SYSCALL", 1700000000, 123, 1000, "success=yes"),
      record("USER", 1700000000, 124, 1001, "acct=u\u2028name=odd"),
    ].join("\n"),
  );
  expect(metadata.malformed_line_count).toBe(0);
  expect(metadata.record_count).toBe(2);
  expect(metadata.event_count).toBe(2);
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

it("bounds retained event state and reports the window in its limitations", async () => {
  const lines = Array.from({ length: 5000 }, (_unused, index) =>
    record("SYSCALL", 1700000000, 100, 1000 + index, "success=yes"),
  );
  const reader = new AuditdLogArtifactReader(
    await writeLog("audit.log", `${lines.join("\n")}\n`),
  );
  try {
    for await (const _entry of reader.entries()) {
      // No members; the parse itself builds the inventory.
    }
    const metadata = reader.formatMetadata();
    if (metadata?.kind !== "auditd-log")
      throw new Error("Expected auditd-log metadata");
    expect(metadata.event_count).toBe(5000);
    expect(metadata.events).toHaveLength(32);
    expect(metadata.omitted_events).toBe(4968);
  } finally {
    await reader.close();
  }
});

it("reports cancellation requested from the coverage callback", async () => {
  const reader = new AuditdLogArtifactReader(
    await writeLog("audit.log", `${EXECUTION_EVENT}\n`),
  );
  const controller = new AbortController();
  try {
    const entries = reader
      .entries(controller.signal, {
        onCoverage: () => controller.abort(),
      })
      [Symbol.asyncIterator]();
    await expect(entries.next()).rejects.toMatchObject({ reason: "cancelled" });
  } finally {
    await reader.close();
  }
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
