import { describe, expect, it } from "vitest";

import { nativeCallPartialObservationSchema } from "../../../../src/domain/native/nativeCallPartialObservation.js";
import {
  LLDB_OBSERVATION_JOURNAL_MAX_BYTES,
  parseLldbObservationJournal,
  projectLldbPartialObservation,
  readBoundedPrefix,
} from "../../../../src/native/LldbRetainedObservations.js";

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

const observation = (
  reason: "cancelled" | "tracer-failure" | "cleanup-failure",
  journalText: string,
) => {
  const parsed = parseLldbObservationJournal(Buffer.from(journalText));
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
  it.each([
    ["cancellation", "cancelled"],
    ["bridge failure", "tracer-failure"],
    ["cleanup failure", "cleanup-failure"],
  ] as const)("retains admitted events after %s", (_case, reason) => {
    const journal = `${JSON.stringify({ kind: "event", event })}\n`;
    const partial = observation(reason, journal);
    expect(partial.events).toEqual([event]);
    expect(partial.coverage).toEqual({ status: "partial", reason });
    expect(partial.process.stdout).toMatchObject({
      text: "prefix",
      bytes: 6,
      complete: false,
      truncated: true,
    });
    expect(partial.process.stderr).toBeNull();
    expect(partial.limitations).toContain(
      "The target stderr capture was unavailable.",
    );
  });

  it("keeps valid rows around malformed data and ignores a torn final row", () => {
    const journal = [
      JSON.stringify({ kind: "event", event }),
      "{bad-json}",
      JSON.stringify({ kind: "other-stop", reason: "signal SIGTERM" }),
      '{"kind":"event","event":',
    ].join("\n");
    const partial = observation("tracer-failure", journal);
    expect(partial.events).toEqual([event]);
    expect(partial.process.other_stops).toEqual(["signal SIGTERM"]);
    expect(partial.limitations).toContain(
      "1 observation journal row(s) were malformed or invalid and ignored (first at row 2).",
    );
    expect(partial.limitations).toContain(
      "The final observation journal record was incomplete and was ignored.",
    );
  });

  it("bounds malformed-row diagnostics for an 8 MiB journal", () => {
    const valid = JSON.stringify({ kind: "event", event });
    const malformed = '{"kind":"unknown"}\n';
    const malformedRows = Math.floor(
      (LLDB_OBSERVATION_JOURNAL_MAX_BYTES - valid.length * 2 - 2) /
        malformed.length,
    );
    const journal = `${valid}\n${malformed.repeat(malformedRows)}${valid}\n`;
    expect(Buffer.byteLength(journal)).toBeLessThanOrEqual(
      LLDB_OBSERVATION_JOURNAL_MAX_BYTES,
    );
    const partial = observation("tracer-failure", journal);
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
    const source = Buffer.from("retained prefix");
    let position = 0;
    const result = await readBoundedPrefix(
      source.length,
      async (buffer, offset, length, requestedPosition) => {
        expect(requestedPosition).toBe(position);
        const count = Math.min(2, length, source.length - position);
        source.copy(buffer, offset, position, position + count);
        position += count;
        return count;
      },
    );
    expect(result.bytesRead).toBe(source.length);
    expect(result.buffer.toString("utf8", 0, result.bytesRead)).toBe(
      "retained prefix",
    );
  });
});
