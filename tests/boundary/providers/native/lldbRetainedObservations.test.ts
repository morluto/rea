import { describe, expect, it } from "vitest";
import type { FileHandle } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { err, ok, type Result } from "../../../../src/domain/result.js";
import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";

import { nativeCallPartialObservationSchema } from "../../../../src/domain/native/nativeCallPartialObservation.js";
import {
  projectLldbPartialObservation,
  readLldbObservationJournal,
  readPartialCapture,
} from "../../../../src/native/LldbRetainedObservations.js";
import { LldbReadbackFiles } from "../../../../src/native/LldbReadbackFiles.js";

const event = {
  sequence: 0,
  elapsed_ms: 1,
  thread_id: 2,
  breakpoint_index: 0,
  load_address: "0x1000",
  file_address: "0x1000",
  module: "fixture",
  module_path: "/tmp/fixture",
  symbol: "main",
  receiver_class: null,
  selector: null,
  registers: [],
  backtrace: [],
};

const readJournal = async (bytes: Buffer) => {
  const root = await createTestTempDirectory("rea-lldb-journal-");
  const path = join(root, "journal");
  await writeFile(path, bytes);
  const result = await readLldbObservationJournal(
    path,
    new LldbReadbackFiles(),
    bytes.length,
  );
  if (!result.ok) throw result.error;
  return result.value.parsed;
};

const observation = async (
  reason: "cancelled" | "tracer-failure" | "cleanup-failure",
  journalText: string,
) => {
  const parsed = await readJournal(Buffer.from(journalText));
  return nativeCallPartialObservationSchema.parse(
    projectLldbPartialObservation({
      target: {
        path: "/tmp/fixture",
        sha256: "a".repeat(64),
        architecture: "arm64",
        arguments: ["--selected"],
        environment: { SELECTED_VALUE: "retained" },
        working_directory: "/tmp",
      },
      pid: 42,
      stdout: { text: "prefix", bytes: 6, truncated: true, complete: false },
      stderr: null,
      version: null,
      journal: parsed,
      reason,
    }),
  );
};

describe("LLDB retained observations", () => {
  it("preserves partial source coordinates while accepting historical omission", async () => {
    const attributed = {
      ...event,
      source_location: {
        file_path: "/missing/fixture.pas",
        line: 23,
        column: null,
      },
    };
    const journal =
      [event, attributed]
        .map((entry) => JSON.stringify({ kind: "event", event: entry }))
        .join("\n") + "\n";
    const partial = await observation("cancelled", journal);
    expect(partial.events).toEqual([event, attributed]);
    expect(partial.limitations).toContain(
      "Source paths and lines are LLDB line-table attribution; REA did not read or verify the referenced source bytes.",
    );
  });

  it.each([
    ["cancellation", "cancelled"],
    ["bridge failure", "tracer-failure"],
    ["cleanup failure", "cleanup-failure"],
  ] as const)("retains admitted events after %s", async (_case, reason) => {
    const journal = `${JSON.stringify({ kind: "event", event })}\n`;
    const partial = await observation(reason, journal);
    expect(partial.events).toEqual([event]);
    expect(partial.coverage).toEqual({ status: "partial", reason });
    expect(partial.process.stdout).toMatchObject({
      text: "prefix",
      bytes: 6,
      complete: false,
      truncated: true,
    });
    expect(partial.process.stderr).toBeNull();
    expect(partial.process).not.toHaveProperty("exit_status");
    expect(partial.process).not.toHaveProperty("terminated");
    expect(partial.target).not.toHaveProperty("launch_identity");
    expect(partial).not.toHaveProperty("breakpoints");
    expect(partial.limitations).toContain(
      "The target stderr capture was unavailable.",
    );
  });

  it("keeps valid rows around malformed data and ignores a torn final row", async () => {
    const journal = [
      JSON.stringify({ kind: "event", event }),
      "{bad-json}",
      JSON.stringify({ kind: "other-stop", reason: "signal SIGTERM" }),
      '{"kind":"event","event":',
    ].join("\n");
    const partial = await observation("tracer-failure", journal);
    expect(partial.events).toEqual([event]);
    expect(partial.process.other_stops).toEqual(["signal SIGTERM"]);
    expect(partial.limitations).toContain(
      "1 observation journal row(s) were malformed or invalid and ignored (first at row 2).",
    );
    expect(partial.limitations).toContain(
      "The final observation journal record was incomplete and was ignored.",
    );
  });

  it("rejects invalid UTF-8 rows while retaining valid neighbors and literal replacement characters", async () => {
    const before = Buffer.from(`${JSON.stringify({ kind: "event", event })}\n`);
    const invalid = Buffer.concat([
      Buffer.from('{"kind":"other-stop","reason":"before'),
      Buffer.from([0xff]),
      Buffer.from('after"}\n'),
    ]);
    const literalReplacement = Buffer.from(
      `${JSON.stringify({ kind: "other-stop", reason: "literal �" })}\n`,
    );
    const after = Buffer.from(
      `${JSON.stringify({ kind: "event", event: { ...event, sequence: 1 } })}\n`,
    );
    const parsed = await readJournal(
      Buffer.concat([before, invalid, literalReplacement, after]),
    );

    expect(parsed.events).toEqual([event, { ...event, sequence: 1 }]);
    expect(parsed.otherStops).toEqual(["literal �"]);
    expect(parsed.limitations).toContain(
      "1 observation journal row(s) were malformed or invalid and ignored (first at row 2).",
    );
  });

  it("ignores a torn non-ASCII tail without discarding completed rows", async () => {
    const complete = Buffer.from(
      `${JSON.stringify({ kind: "event", event })}\n`,
    );
    const torn = Buffer.concat([
      Buffer.from('{"kind":"other-stop","reason":"'),
      Buffer.from([0xe2, 0x82]),
    ]);
    const parsed = await readJournal(Buffer.concat([complete, torn]));

    expect(parsed.events).toEqual([event]);
    expect(parsed.otherStops).toEqual([]);
    expect(parsed.limitations).toContain(
      "The final observation journal record was incomplete and was ignored.",
    );
    expect(parsed.limitations).not.toContain(
      expect.stringContaining("malformed or invalid"),
    );
  });
});

describe("LLDB retained observation read failures", () => {
  it("bounds malformed-row diagnostics for an 8 MiB journal", async () => {
    const valid = JSON.stringify({ kind: "event", event });
    const malformed = '{"kind":"unknown"}\n';
    const malformedRows = Math.floor(
      (8 * 1024 * 1024 - valid.length * 2 - 2) / malformed.length,
    );
    const journal = `${valid}\n${malformed.repeat(malformedRows)}${valid}\n`;
    expect(Buffer.byteLength(journal)).toBeLessThanOrEqual(8 * 1024 * 1024);
    const partial = await observation("tracer-failure", journal);
    expect(partial.events).toEqual([event, event]);
    expect(partial.limitations.length).toBeLessThanOrEqual(6);
    expect(
      partial.limitations.find((limitation) =>
        limitation.includes("malformed"),
      ),
    ).toMatch(
      /^\d+ observation journal row\(s\) were malformed or invalid and ignored \(first at row 2\)\.$/u,
    );
  });

  it("continues a bounded prefix read after short reads", async () => {
    const source = Buffer.from(`${JSON.stringify({ kind: "event", event })}\n`);
    let position = 0;
    const files = {
      read: async <Value>(
        _path: string,
        read: (file: FileHandle) => Promise<Value>,
      ): Promise<Result<Value, unknown>> => {
        const handle = {
          stat: async () => ({ size: source.length }),
          read: async (
            buffer: Buffer,
            offset: number,
            length: number,
            requestedPosition: number,
          ) => {
            expect(requestedPosition).toBe(position);
            const count = Math.min(2, length, source.length - position);
            source.copy(buffer, offset, position, position + count);
            position += count;
            return { bytesRead: count, buffer };
          },
        } as unknown as FileHandle;
        try {
          return ok(await read(handle));
        } catch (cause) {
          return err(cause);
        }
      },
    } as LldbReadbackFiles;
    const result = await readLldbObservationJournal("journal", files);
    if (!result.ok) throw result.error;
    expect(position).toBe(source.length);
    expect(result.value.status).toBe("complete");
    expect(result.value.parsed.events).toEqual([event]);
  });

  it("reads the selected partial capture and journal budgets instead of fixed defaults", async () => {
    const source = Buffer.from("retained-output");
    const first = await readPartialCapture(
      "stdout",
      readbackFilesFailingAfter(source, source.length, new Error("unused")),
      8,
    );
    const raised = await readPartialCapture(
      "stdout",
      readbackFilesFailingAfter(source, source.length, new Error("unused")),
      32,
    );
    if (!first.ok || !raised.ok)
      throw new Error("Expected retained output reads");
    expect(first.value.capture.text).toBe("retained");
    expect(raised.value.capture.text).toBe("retained-output");
    const row = `${JSON.stringify({ kind: "event", event })}\n`;
    const journal = Buffer.from(row.repeat(2));
    const limited = await readLldbObservationJournal(
      "journal",
      readbackFilesFailingAfter(journal, journal.length, new Error("unused")),
      Buffer.byteLength(row),
    );
    const complete = await readLldbObservationJournal(
      "journal",
      readbackFilesFailingAfter(journal, journal.length, new Error("unused")),
      journal.length,
    );
    if (!limited.ok || !complete.ok)
      throw new Error("Expected retained journal reads");
    expect(limited.value.parsed.events).toEqual([event]);
    expect(complete.value.parsed.events).toEqual([event, event]);
    expect(limited.value.limitations).toContainEqual(
      expect.stringContaining("capture_limits.trace_bytes"),
    );
  });

  it("retains completed journal rows and the exact cause after a later read fails", async () => {
    const completeRow = `${JSON.stringify({ kind: "event", event })}\n`;
    const source = Buffer.from(`${completeRow}{"kind":"event"`);
    const failure = Object.assign(new Error("controlled EIO"), { code: "EIO" });
    const files = readbackFilesFailingAfter(
      source,
      Buffer.byteLength(completeRow),
      failure,
    );
    const result = await readLldbObservationJournal("journal", files);

    if (!result.ok) throw result.error;
    expect(result.value.status).toBe("read-failure");
    if (result.value.status !== "read-failure")
      throw new Error("Expected partial journal read failure");
    expect(result.value.parsed.events).toEqual([event]);
    expect(result.value.readFailure).toBe(failure);
    expect(result.value.limitations).toContain(
      `The observation journal read failed after ${String(Buffer.byteLength(completeRow))} bytes: controlled EIO`,
    );
  });

  it("retains an output prefix with a tagged read failure, but zero-byte failure remains an error", async () => {
    const prefix = "first output prefix";
    const source = Buffer.from(`${prefix} followed by unavailable bytes`);
    const failure = Object.assign(new Error("controlled EIO"), { code: "EIO" });
    const partial = await readPartialCapture(
      "stdout",
      readbackFilesFailingAfter(source, Buffer.byteLength(prefix), failure),
    );
    if (!partial.ok) throw partial.error;
    expect(partial.value.status).toBe("read-failure");
    if (partial.value.status !== "read-failure")
      throw new Error("Expected partial output read failure");
    expect(partial.value.capture).toMatchObject({
      text: prefix,
      truncated: true,
      complete: false,
    });
    expect(partial.value.readFailure).toBe(failure);

    const firstReadFailure = await readPartialCapture(
      "stdout",
      readbackFilesFailingAfter(source, 0, failure),
    );
    expect(firstReadFailure.ok).toBe(false);
    if (!firstReadFailure.ok) expect(firstReadFailure.error).toBe(failure);
  });
});

const readbackFilesFailingAfter = (
  source: Buffer,
  retainedBytes: number,
  failure: Error,
): LldbReadbackFiles => {
  let calls = 0;
  const handle = {
    stat: async () => ({ size: source.byteLength }),
    read: async (
      buffer: Buffer,
      offset: number,
      length: number,
      position: number,
    ) => {
      calls += 1;
      if (calls === 1 && retainedBytes === 0) throw failure;
      if (calls > 1) throw failure;
      const bytesRead = Math.min(retainedBytes, length);
      source.copy(buffer, offset, position, position + bytesRead);
      return { bytesRead, buffer };
    },
  } as unknown as FileHandle;
  return {
    read: async <Value>(
      _path: string,
      read: (file: FileHandle) => Promise<Value>,
    ): Promise<Result<Value, unknown>> => {
      try {
        return ok(await read(handle));
      } catch (cause: unknown) {
        return err(cause);
      }
    },
  } as LldbReadbackFiles;
};
