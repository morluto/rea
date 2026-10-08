import { open } from "node:fs/promises";

import { nativeCallEventSchema } from "../domain/native/nativeCallObservation.js";
import type { NativeCallPartialObservation } from "../domain/native/nativeCallPartialObservation.js";

/** Maximum journal size enforced by the LLDB bridge. */
export const LLDB_OBSERVATION_JOURNAL_MAX_BYTES = 8 * 1024 * 1024;
const MAX_CAPTURE_BYTES = 1024 * 1024;

export interface ParsedLldbJournal {
  readonly events: ReturnType<typeof nativeCallEventSchema.parse>[];
  readonly otherStops: string[];
  readonly limitations: string[];
}

export interface PartialCaptureRead {
  readonly capture: NonNullable<
    NativeCallPartialObservation["process"]["stdout"]
  >;
  readonly limitations: readonly string[];
}

/** Join safely retained journal and process evidence into its failure contract. */
export const projectLldbPartialObservation = (input: {
  readonly target: NativeCallPartialObservation["target"];
  readonly pid: number | undefined;
  readonly stdout: NativeCallPartialObservation["process"]["stdout"];
  readonly stderr: NativeCallPartialObservation["process"]["stderr"];
  readonly version: string | null;
  readonly journal: ParsedLldbJournal;
  readonly journalLimitations?: readonly string[];
  readonly limitations?: readonly string[];
  readonly reason: NativeCallPartialObservation["coverage"]["reason"];
}): NativeCallPartialObservation => ({
  kind: "native-call-observation",
  target: input.target,
  process: {
    pid: input.pid ?? null,
    stdout: input.stdout,
    stderr: input.stderr,
    other_stops: input.journal.otherStops,
  },
  debugger: { version: input.version },
  events: input.journal.events,
  coverage: { status: "partial", reason: input.reason },
  limitations: [
    "The LLDB run did not produce a complete native call observation result.",
    "The target SHA-256 identifies the selected artifact; LLDB did not verify the bytes loaded into the process.",
    "Captured output byte counts are observed lower bounds because LLDB did not report final stream counters.",
    ...input.journal.limitations,
    ...(input.journalLimitations ?? []),
    ...(input.limitations ?? []),
    ...(input.pid === undefined ? ["The target PID was unavailable."] : []),
    ...(input.stdout === null
      ? ["The target stdout capture was unavailable."]
      : []),
    ...(input.stderr === null
      ? ["The target stderr capture was unavailable."]
      : []),
  ],
});

/** Parse completed JSONL records while retaining valid records around bad ones. */
export const parseLldbObservationJournal = (
  bytes: Uint8Array,
): ParsedLldbJournal => {
  const completeText = Buffer.from(bytes).toString("utf8");
  const newline = completeText.lastIndexOf("\n");
  const hasTornTail = newline !== completeText.length - 1;
  const events: ParsedLldbJournal["events"] = [];
  const otherStops: string[] = [];
  const limitations: string[] = [];
  let malformedCount = 0;
  let firstMalformedRow: number | undefined;
  let start = 0;
  let rowNumber = 0;
  while (start <= newline && newline >= 0) {
    const end = completeText.indexOf("\n", start);
    if (end < 0 || end > newline) break;
    const line = completeText.slice(start, end);
    start = end + 1;
    if (line.length === 0) continue;
    rowNumber += 1;
    const markMalformed = () => {
      malformedCount += 1;
      firstMalformedRow ??= rowNumber;
    };
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      markMalformed();
      continue;
    }
    if (
      typeof row !== "object" ||
      row === null ||
      !("kind" in row) ||
      typeof row.kind !== "string"
    ) {
      markMalformed();
      continue;
    }
    if (row.kind === "event" && "event" in row) {
      const event = nativeCallEventSchema.safeParse(row.event);
      if (event.success) events.push(event.data);
      else markMalformed();
    } else if (
      row.kind === "other-stop" &&
      "reason" in row &&
      typeof row.reason === "string"
    ) {
      otherStops.push(row.reason);
    } else {
      markMalformed();
    }
  }
  if (malformedCount > 0)
    limitations.push(
      `${malformedCount} observation journal row(s) were malformed or invalid and ignored (first at row ${String(firstMalformedRow)}).`,
    );
  if (hasTornTail)
    limitations.push(
      "The final observation journal record was incomplete and was ignored.",
    );
  return { events, otherStops, limitations };
};

/** Keep reading a bounded prefix across short reads until EOF or the bound. */
export const readBoundedPrefix = async (
  requestedBytes: number,
  readChunk: (
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ) => Promise<number>,
): Promise<{ readonly buffer: Buffer; readonly bytesRead: number }> => {
  const buffer = Buffer.alloc(requestedBytes);
  let bytesRead = 0;
  while (bytesRead < requestedBytes) {
    const count = await readChunk(
      buffer,
      bytesRead,
      requestedBytes - bytesRead,
      bytesRead,
    );
    if (count === 0) break;
    if (count > requestedBytes - bytesRead)
      throw new Error("The bounded read returned more bytes than requested");
    bytesRead += count;
  }
  return { buffer, bytesRead };
};

const readPrefix = (
  handle: Awaited<ReturnType<typeof open>>,
  requestedBytes: number,
) =>
  readBoundedPrefix(
    requestedBytes,
    async (buffer, offset, length, position) =>
      (await handle.read(buffer, offset, length, position)).bytesRead,
  );

/** Read at most the bridge's journal bound, checking size before allocation. */
export const readLldbObservationJournal = async (
  path: string,
): Promise<{
  readonly parsed: ParsedLldbJournal;
  readonly limitations: string[];
}> => {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    const { size } = await handle.stat();
    const length = Math.min(size, LLDB_OBSERVATION_JOURNAL_MAX_BYTES);
    const { buffer, bytesRead } = await readPrefix(handle, length);
    const parsed = parseLldbObservationJournal(buffer.subarray(0, bytesRead));
    const limitations = [
      ...(size > LLDB_OBSERVATION_JOURNAL_MAX_BYTES
        ? [
            "The observation journal exceeded 8 MiB; only its bounded prefix was read.",
          ]
        : []),
      ...(bytesRead < length
        ? [
            "The observation journal became shorter while being read; the available prefix was parsed.",
          ]
        : []),
    ];
    return {
      parsed,
      limitations,
    };
  } catch (cause: unknown) {
    return {
      parsed: { events: [], otherStops: [], limitations: [] },
      limitations: [
        `The observation journal could not be read: ${cause instanceof Error ? cause.message : String(cause)}`,
      ],
    };
  } finally {
    await handle?.close().catch(() => undefined);
  }
};

/** Retain an available output prefix without claiming an unreported total. */
export const readPartialCapture = async (
  path: string,
): Promise<PartialCaptureRead | null> => {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    const { size } = await handle.stat();
    const length = Math.min(size, MAX_CAPTURE_BYTES);
    const { buffer, bytesRead } = await readPrefix(handle, length);
    return {
      capture: {
        text: buffer.subarray(0, bytesRead).toString("utf8"),
        bytes: Math.max(size, bytesRead),
        truncated: true,
        complete: false,
      },
      limitations:
        bytesRead < length
          ? [
              "A target output capture became shorter while being read; its retained prefix may be incomplete.",
            ]
          : [],
    };
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
};
