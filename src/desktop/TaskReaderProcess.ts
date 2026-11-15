import { randomUUID } from "node:crypto";

import type { ReaderCommandResult } from "../domain/desktop/appTaskReaders.js";
import { runOwnedCommand } from "../process/OwnedCommand.js";

/** The most a reader runner prints, its one answer line, plus room for what Python says when it fails. */
const RUNNER_OUTPUT_BYTES = 2 * 1024 * 1024;

/**
 * Run a reader's runner command on this host, as the export does inside the
 * build computer, as an owned process: a timeout or a cancellation stops the
 * runner and every process carrying its run token, the reader's session
 * included, before it settles.
 */
export const runReaderHere = async (
  argv: readonly string[],
  timeoutS: number,
  signal?: AbortSignal,
): Promise<ReaderCommandResult> => {
  const [command = "", ...rest] = argv;
  const snapshot = await runOwnedCommand(
    {
      command,
      arguments: rest,
      runId: randomUUID(),
      expectedCommand: null,
      sweepTokenOwnedProcesses: true,
    },
    {
      timeoutMs: timeoutS * 1000,
      diagnosticBytes: RUNNER_OUTPUT_BYTES,
      acceptNonZeroExit: true,
    },
    signal === undefined ? {} : { signal },
  );
  return {
    exit_code: snapshot.exitCode ?? null,
    stdout: snapshot.stdout.text,
    stderr: snapshot.stderr.text,
    timed_out: false,
  };
};
