import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { ProcessOutputTokenScanner } from "./ProcessOutputTokenScanner.js";
import { ProviderProcessSupervisor } from "./ProviderProcess.js";

const MARKER = "java.lang.OutOfMemoryError";
const EXPECTED_CONTEXT_BYTES = 1024;
const OOME_LINE =
  "ERROR Abort due to Headless analyzer error: Java heap space (HeadlessAnalyzer) java.lang.OutOfMemoryError: Java heap space";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const supervised = (
  maxDiagnosticBytes = 64,
  outputToken: string | null = MARKER,
) => {
  const producer = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
    kill: () => false,
  });
  const supervisor = new ProviderProcessSupervisor(
    { process: producer, ownsProcessLifetime: false },
    {
      maxDiagnosticBytes,
      ...(outputToken === null ? {} : { outputToken }),
    },
  );
  cleanups.push(() => {
    supervisor.dispose();
    producer.stdout.destroy();
    producer.stderr.destroy();
  });
  return { producer, supervisor };
};

describe("ProviderProcessSupervisor output marker", () => {
  it("keeps token offsets and context on both streams after capture fills", () => {
    const { producer, supervisor } = supervised();
    const checkpoint = supervisor.checkpointOutput();
    const progress = `${"x".repeat(200)}\n`;
    producer.stdout.write(progress);
    const split = OOME_LINE.indexOf(MARKER) + 7;
    producer.stdout.write(OOME_LINE.slice(0, 20));
    producer.stdout.write(OOME_LINE.slice(20, split));
    producer.stdout.write(`${OOME_LINE.slice(split)}\nnext\n`);
    producer.stderr.write(`${OOME_LINE}\n\tat frame\n`);

    const scoped = supervisor.snapshotOutputSince(checkpoint);
    expect(scoped.complete).toBe(false);
    expect(scoped.snapshot.stderr.text).toBe("");
    const offset = OOME_LINE.indexOf(MARKER);
    expect(scoped.markers).toEqual([
      {
        stream: "stdout",
        offset: progress.length + offset,
        line: OOME_LINE,
        truncated: false,
      },
      { stream: "stderr", offset, line: OOME_LINE, truncated: false },
    ]);
  });

  it("excludes earlier markers, including a split marker crossing the checkpoint, and forgets them on reset", () => {
    const { producer, supervisor } = supervised(0);
    const stale = supervisor.checkpointOutput();
    producer.stderr.write(`${OOME_LINE}\n`);
    const afterOld = supervisor.checkpointOutput();
    producer.stderr.write("unrelated failure\n");
    expect(supervisor.snapshotOutputSince(afterOld).markers).toBeUndefined();

    producer.stderr.write(MARKER.slice(0, 10));
    const afterPrefix = supervisor.checkpointOutput();
    producer.stderr.write(`${MARKER.slice(10)}: Java heap space\n`);
    expect(supervisor.snapshotOutputSince(afterPrefix).markers).toBeUndefined();

    supervisor.resetOutput();
    expect(supervisor.snapshotOutputSince(stale).markers).toBeUndefined();
    const current = supervisor.checkpointOutput();
    producer.stderr.write("after reset\n");
    expect(supervisor.snapshotOutputSince(current).markers).toBeUndefined();
  });

  it("does not scan when no marker is configured", () => {
    const { producer, supervisor } = supervised(0, null);
    const checkpoint = supervisor.checkpointOutput();
    producer.stderr.write(`${OOME_LINE}\n`);
    expect(supervisor.snapshotOutputSince(checkpoint).markers).toBeUndefined();
  });
});

describe("ProcessOutputTokenScanner", () => {
  it("bounds the retained line and omits a prefix it could not keep whole", () => {
    const scanner = new ProcessOutputTokenScanner(MARKER);
    const prefix = "p".repeat(EXPECTED_CONTEXT_BYTES * 3);
    const suffix = `: ${"s".repeat(EXPECTED_CONTEXT_BYTES * 3)}`;
    scanner.scan(Buffer.from(prefix.slice(0, 1000)), 0);
    scanner.scan(Buffer.from(prefix.slice(1000)), 1000);
    scanner.scan(Buffer.from(`${MARKER}${suffix.slice(0, 50)}`), prefix.length);
    scanner.scan(
      Buffer.from(`${suffix.slice(50)}\n`),
      prefix.length + MARKER.length + 50,
    );
    const observed = scanner.latestWithin(0, Number.MAX_SAFE_INTEGER);
    expect(observed).toEqual({
      offset: prefix.length,
      line: `${MARKER}${suffix.slice(0, EXPECTED_CONTEXT_BYTES)}`,
      truncated: true,
      trailingContextIncomplete: true,
    });
  });

  it.each([
    { label: "a newline exactly at the limit", extra: 0, ending: "\n" },
    { label: "a newline past the limit", extra: 1, ending: "\n" },
    { label: "EOF past the limit", extra: 1, ending: "" },
  ])("reports suffix completeness with $label", ({ extra, ending }) => {
    const prefix = "x";
    const suffix = `:${"s".repeat(EXPECTED_CONTEXT_BYTES - 1 + extra)}`;
    const scanner = new ProcessOutputTokenScanner(MARKER);
    const lastChunk = Buffer.from(`${MARKER}${suffix}${ending}`);
    scanner.scan(Buffer.from(prefix), 0);
    scanner.scan(lastChunk, prefix.length);
    const expected = {
      offset: prefix.length,
      line: `${prefix}${MARKER}${suffix.slice(0, EXPECTED_CONTEXT_BYTES)}`,
      truncated: extra > 0,
      ...(extra > 0 ? { trailingContextIncomplete: true } : {}),
    };
    expect(scanner.latestWithin(0, prefix.length + lastChunk.length)).toEqual(
      expected,
    );
    scanner.finish();
    expect(scanner.latestWithin(0, prefix.length + lastChunk.length)).toEqual(
      expected,
    );
  });

  it("keeps the latest confirmed marker as its line arrives in fragments", () => {
    const scanner = new ProcessOutputTokenScanner(MARKER);
    const first = `old ${MARKER}\nnewer ${MARKER}\nlatest ${MARKER}`;
    const suffix = ": Metaspace";
    scanner.scan(Buffer.from(first), 0);
    expect(scanner.latestWithin(0, first.length)).toEqual({
      offset: first.indexOf(MARKER, first.indexOf("\n")),
      line: `newer ${MARKER}`,
      truncated: false,
    });
    scanner.scan(Buffer.from(suffix), first.length);
    scanner.scan(Buffer.from("\n"), first.length + suffix.length);
    expect(scanner.latestWithin(0, first.length + suffix.length + 1)).toEqual({
      offset: first.lastIndexOf(MARKER),
      line: `latest ${MARKER}${suffix}`,
      truncated: false,
    });
  });
});

it("keeps a confirmed token when a later identifier shares its literal prefix across every chunk split", () => {
  const valid = `${OOME_LINE}\n`;
  const invalid = `${MARKER}Custom: ordinary identifier\n`;
  const text = Buffer.from(valid + invalid);
  for (let split = 0; split <= text.length; split++) {
    const scanner = new ProcessOutputTokenScanner(MARKER);
    scanner.scan(text.subarray(0, split), 0);
    scanner.scan(text.subarray(split), split);
    scanner.finish();
    expect(scanner.latestWithin(0, text.length)).toMatchObject({
      line: OOME_LINE,
      offset: OOME_LINE.indexOf(MARKER),
    });
  }
});

it("omits line context owned by an earlier operation even when the token starts at the checkpoint", () => {
  const { producer, supervisor } = supervised(0);
  producer.stderr.write("earlier operation: unable to create native thread; ");
  const checkpoint = supervisor.checkpointOutput();
  producer.stderr.write(`${MARKER}: Java heap space\n`);
  expect(supervisor.snapshotOutputSince(checkpoint).markers).toEqual([
    {
      stream: "stderr",
      offset: "earlier operation: unable to create native thread; ".length,
      line: `${MARKER}: Java heap space`,
      truncated: true,
    },
  ]);
});

it.each(["end", "close"] as const)(
  "confirms a terminal bare token at EOF, with stderr %s",
  async (event) => {
    const { producer, supervisor } = supervised(0);
    const checkpoint = supervisor.checkpointOutput();
    producer.stderr.write(MARKER);
    expect(supervisor.snapshotOutputSince(checkpoint).markers).toBeUndefined();

    const observed = once(producer.stderr, event);
    if (event === "end") producer.stderr.end();
    else producer.stderr.destroy();
    await observed;
    if (event === "close") producer.emit("close", 1, null);
    expect(supervisor.snapshotOutputSince(checkpoint).markers).toEqual(
      event === "end"
        ? [{ stream: "stderr", offset: 0, line: MARKER, truncated: false }]
        : undefined,
    );
  },
);

it("preserves invalid UTF-8 uncertainty in bounded token context", () => {
  const scanner = new ProcessOutputTokenScanner(MARKER);
  const bytes = Buffer.concat([
    Buffer.from(`${MARKER}: `),
    Buffer.from([0xff]),
    Buffer.from("\n"),
  ]);
  scanner.scan(bytes, 0);
  expect(scanner.latestWithin(0, bytes.length)).toMatchObject({
    offset: 0,
    line: `${MARKER}: \ufffd`,
    invalidUtf8: true,
  });
});
