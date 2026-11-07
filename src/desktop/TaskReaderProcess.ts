import { execFile } from "node:child_process";

import type { ReaderCommandResult } from "../domain/desktop/appTaskReaders.js";

/** The most a reader runner prints, its one answer line, plus room for what Python says when it fails. */
const RUNNER_OUTPUT_BYTES = 2 * 1024 * 1024;

/** Run a reader's runner command on this host, as the export does inside the build computer; cancellation rejects. */
export const runReaderHere = (
  argv: readonly string[],
  timeoutS: number,
  signal?: AbortSignal,
): Promise<ReaderCommandResult> =>
  new Promise((resolve, reject) => {
    const [command = "", ...rest] = argv;
    execFile(
      command,
      rest,
      {
        encoding: "utf8",
        timeout: timeoutS * 1000,
        killSignal: "SIGKILL",
        maxBuffer: RUNNER_OUTPUT_BYTES,
        ...(signal === undefined ? {} : { signal }),
      },
      (error, stdout, stderr) => {
        if (signal?.aborted === true) {
          reject(signal.reason as Error);
          return;
        }
        const code = error === null ? 0 : error.code;
        // A string code is a failure to run, such as no python3 or too much output, not an exit status.
        if (typeof code === "string") {
          reject(error as Error);
          return;
        }
        resolve({
          exit_code: code ?? null,
          stdout,
          stderr,
          timed_out: error?.killed === true,
        });
      },
    );
  });
