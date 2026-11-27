import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { AuditdLogArtifactReader } from "./AuditdLogArtifactReader.js";
import {
  AUDITD_RETAINED_EVENT_TYPE_LIMIT,
  AUDITD_RETAINED_OMITTED_TYPE_LIMIT,
  AUDITD_RETAINED_RECORD_LIMIT,
  AUDITD_RETAINED_TYPE_LIMIT,
} from "../domain/linux/auditdLog.js";
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
  // The log declares no members, so the traversal only builds the inventory
  // and reports what it could not establish through the coverage callback.
  const limitations: string[] = [];
  try {
    for await (const _entry of reader.entries(undefined, {
      onCoverage: (coverage) => limitations.push(...coverage.limitations),
    })) {
      // No members.
    }
    const metadata = reader.formatMetadata();
    if (metadata?.kind !== "auditd-log")
      throw new Error("Expected auditd-log metadata");
    return { ...metadata, limitations };
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

it("counts a contiguous tail event once past the retained window", async () => {
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
  expect(metadata.event_count_upper_bound).toBe(false);
});

it("reports the tail event total as an upper bound when a run repeats", async () => {
  const lines = Array.from({ length: 4096 }, (_unused, index) =>
    record("SYSCALL", 1700000000, 100, 1000 + index, "success=yes"),
  );
  // A, B, A: the second run of A is the same event counted again, so the total
  // over-counts and must not be presented as an exact count.
  lines.push(
    record("SYSCALL", 1700000000, 200, 5000, "success=yes"),
    record("SYSCALL", 1700000000, 300, 6000, "success=yes"),
    record("SYSCALL", 1700000000, 200, 5000, "success=yes"),
  );
  const metadata = await metadataOf(`${lines.join("\n")}\n`);
  expect(metadata.event_count).toBe(4099);
  // The second run of A repeats an event, so the total can only be an upper
  // bound and no honest lower bound exists.
  expect(metadata.event_count_upper_bound).toBe(true);
  expect(metadata.event_count_lower_bound).toBe(false);
  expect(metadata.event_count_identity_omitted).toBe(false);
  expect(metadata.limitations.join(" ")).toContain(
    "event_count can be an upper bound",
  );
});

it("reports a single tail event split into runs as an upper bound, not a lower bound", async () => {
  const lines = Array.from({ length: 4096 }, (_unused, index) =>
    record("SYSCALL", 1700000000, 100, 1000 + index, "success=yes"),
  );
  // One tail event, its two records split by a retained event's record. The
  // tail sees the same identity twice and counts it twice; with only that one
  // identity the old code called the total a lower bound, but the run itself
  // already inflated it, so nothing below the upper bound is honest.
  lines.push(
    record("SYSCALL", 1700000000, 200, 5000, "success=yes"),
    record("SYSCALL", 1700000000, 100, 1000, "success=yes"),
    record("EXECVE", 1700000000, 200, 5000, "argc=1 a0=whoami"),
  );
  const metadata = await metadataOf(`${lines.join("\n")}\n`);
  expect(metadata.event_count_upper_bound).toBe(true);
  expect(metadata.event_count_lower_bound).toBe(false);
});

it("names the type sample omission for a wide event", async () => {
  const wide = Array.from({ length: 18 }, (_unused, index) =>
    record(`T${String(index).padStart(2, "0")}`, 1700000000, 100, 1000, "x=1"),
  );
  const metadata = await metadataOf(`${wide.join("\n")}\n`);
  expect(metadata.events[0]?.record_count).toBe(18);
  expect(metadata.events[0]?.record_types).toHaveLength(16);
  // Two distinct types fall past the 16 listed; their records are still counted.
  expect(metadata.events[0]?.record_types_omitted).toBe(2);
  expect(metadata.limitations.join(" ")).toContain(
    "record_types_omitted counts the omitted type names",
  );
});

it("stops retaining record digests within one event and says so", async () => {
  const eventLines = Array.from(
    { length: AUDITD_RETAINED_RECORD_LIMIT + 3 },
    (_unused, index) =>
      record(
        "SYSCALL",
        1700000000,
        100,
        1000,
        `success=yes seq=${String(index)}`,
      ),
  );
  const metadata = await metadataOf(`${eventLines.join("\n")}\n`);
  expect(metadata.duplicate_record_count).toBe(0);
  expect(metadata.limitations.join(" ")).toContain(
    "duplicate_record_count is a lower bound",
  );
});

it("counts omitted type labels once however many records carry them", async () => {
  // 64 distinct types fill the cap; two records then repeat one 65th type. The
  // event holds one label past the cap and two records past it, so the distinct
  // count is one — the old record-based count reported two, which corrupted
  // `record_types_omitted` and the affected-event tally.
  const capped = Array.from(
    { length: AUDITD_RETAINED_EVENT_TYPE_LIMIT },
    (_unused, index) =>
      record(
        `W${String(index).padStart(2, "0")}`,
        1700000000,
        100,
        1000,
        "x=1",
      ),
  );
  capped.push(
    record("PAST", 1700000000, 100, 1000, "x=1"),
    record("PAST", 1700000000, 100, 1000, "x=2"),
  );
  const metadata = await metadataOf(`${capped.join("\n")}\n`);
  const event = metadata.events[0];
  expect(event?.record_count).toBe(AUDITD_RETAINED_EVENT_TYPE_LIMIT + 2);
  // The 16 listed types are W00..W15; 48 more capped types plus PAST fall past
  // the display list. Two records name PAST, but it is one distinct label, so
  // the count is 49 — the old record-based count reported 50.
  expect(event?.record_types_omitted).toBe(64 - 16 + 1);
  expect(metadata.limitations.join(" ")).toContain(
    "1 event(s) hold types past",
  );
});

it("bounds the whole-file type table once the retained window fills", async () => {
  // The window holds 4096 events; a log past it that names a fresh type per
  // record must not grow the totals table with the file.
  const lines = Array.from({ length: 4096 }, (_unused, index) =>
    record("SYSCALL", 1700000000, 100, 1000 + index, "success=yes"),
  );
  for (let index = 0; index <= AUDITD_RETAINED_TYPE_LIMIT; index += 1)
    lines.push(
      record(`Z${String(index)}`, 1700000000, 200, 9000 + index, "x=1"),
    );
  const metadata = await metadataOf(`${lines.join("\n")}\n`);
  expect(metadata.record_count).toBe(4096 + AUDITD_RETAINED_TYPE_LIMIT + 1);
  expect(metadata.event_type_counts.length).toBeLessThanOrEqual(
    AUDITD_RETAINED_TYPE_LIMIT + 1,
  );
  expect(metadata.limitations.join(" ")).toContain(
    "event_type_counts omits those types",
  );
});

it("keeps headers that differ only in invalid bytes as distinct events", async () => {
  // Two lines whose `node=` differs by one byte UTF-8 cannot decode. A lossy
  // decode turns both bytes into U+FFFD, so the two headers become one identity
  // and join into a single event; a byte-faithful header keeps them apart.
  const lineWith = (nodeSuffix: number): Buffer =>
    Buffer.concat([
      Buffer.from("node=host"),
      Buffer.from([nodeSuffix]),
      Buffer.from(" type=SYSCALL msg=audit(1700000000.100:1000): x=1\n"),
    ]);
  const directory = await createTestTempDirectory("rea-auditd-bytes-");
  const path = join(directory, "audit.log");
  await writeFile(path, Buffer.concat([lineWith(0x80), lineWith(0x81)]));
  const reader = new AuditdLogArtifactReader(path);
  try {
    for await (const _entry of reader.entries()) {
      // No members.
    }
    const metadata = reader.formatMetadata();
    if (metadata?.kind !== "auditd-log")
      throw new Error("Expected auditd-log metadata");
    expect(metadata.malformed_line_count).toBe(0);
    // Two raw node values must stay two events; a lossy decode merges them.
    expect(metadata.event_count).toBe(2);
  } finally {
    await reader.close();
  }
});

it("bounds the omitted-label set of one event and reports a lower bound", async () => {
  // The per-event cap fills, then the same event names far more distinct labels
  // than are retained past it. The set must stop growing, and the count must be
  // reported as a lower bound rather than as an exact total.
  const lines = Array.from(
    {
      length:
        AUDITD_RETAINED_EVENT_TYPE_LIMIT +
        AUDITD_RETAINED_OMITTED_TYPE_LIMIT +
        500,
    },
    (_unused, index) =>
      record(
        `T${String(index).padStart(5, "0")}`,
        1700000000,
        100,
        1000,
        "x=1",
      ),
  );
  const metadata = await metadataOf(`${lines.join("\n")}\n`);
  const event = metadata.events[0]!;
  expect(event.record_count).toBe(lines.length);
  expect(event.record_types_omitted_exact).toBe(false);
  // Listed display omissions plus the retained labels past the cap; the 500
  // further labels are not retained, so the reported count is a floor.
  expect(event.record_types_omitted).toBe(
    AUDITD_RETAINED_EVENT_TYPE_LIMIT - 16 + AUDITD_RETAINED_OMITTED_TYPE_LIMIT,
  );
  expect(metadata.limitations.join(" ")).toContain(
    "record_types_omitted is a lower bound",
  );
});

it("reports UTF-8 header text as written and raw bytes when it is not UTF-8", async () => {
  const directory = await createTestTempDirectory("rea-auditd-text-");
  const path = join(directory, "audit.log");
  await writeFile(
    path,
    Buffer.concat([
      Buffer.from(
        "node=hôte type=SYSCALL msg=audit(1700000000.100:1000): x=1\n",
        "utf8",
      ),
      Buffer.from("node=h"),
      Buffer.from([0xff]),
      Buffer.from(" type=SYSCALL msg=audit(1700000000.101:1001): x=1\n"),
      Buffer.from("échec sans en-tête\n", "utf8"),
    ]),
  );
  const reader = new AuditdLogArtifactReader(path);
  try {
    for await (const _entry of reader.entries()) {
      // No members.
    }
    const metadata = reader.formatMetadata();
    if (metadata?.kind !== "auditd-log")
      throw new Error("Expected auditd-log metadata");
    const [utf8, invalid] = metadata.events;
    expect(utf8).toMatchObject({
      node: "hôte",
      event_id: "h%C3%B4te 1700000000.100:1000",
    });
    expect(utf8).not.toHaveProperty("node_hex");
    expect(invalid).toMatchObject({
      node_hex: "68ff",
      event_id: "h%FF 1700000000.101:1001",
    });
    expect(metadata.malformed_lines[0]).toMatchObject({
      excerpt: "échec sans en-tête",
    });
    expect(metadata.malformed_lines[0]).not.toHaveProperty("excerpt_hex");
  } finally {
    await reader.close();
  }
});

it("judges record order within each node rather than across hosts", async () => {
  // Two hosts emit at the same millisecond with unrelated serials. Node `a`
  // follows with a lower serial than its own earlier event: out of order. Node
  // `b`'s low serial says nothing about `a`, so it must not be counted.
  const metadata = await metadataOf(
    [
      "node=a type=SYSCALL msg=audit(1700000000.007:900): x=1",
      "node=b type=SYSCALL msg=audit(1700000000.007:1): x=1",
      "node=a type=SYSCALL msg=audit(1700000000.007:800): x=1",
    ].join("\n") + "\n",
  );
  expect(metadata.event_count).toBe(3);
  // Only the final `a` record is out of order; `b`'s serial is not comparable.
  expect(metadata.out_of_order_record_count).toBe(1);
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
