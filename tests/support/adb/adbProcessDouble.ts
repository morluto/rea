import { vi } from "vitest";

import type { AdbRunOutcome } from "../../../src/adb/AdbProcess.js";
import { OwnedCommandFailure } from "../../../src/process/OwnedCommand.js";

/** What a scripted adb run printed and how it exited (0 unless given). */
export interface AdbDoubleRun {
  readonly stdout?: Buffer | string;
  readonly stderr?: Buffer | string;
  readonly exitCode?: number;
}

type AdbDoubleCommand = (
  arguments_: readonly string[],
) => Promise<AdbDoubleRun>;

/**
 * Scripted adb runs for provider tests that exercise publication, snapshot
 * and cleanup ownership rather than process supervision. `version` answers
 * the client probe; `device` answers every device command. A rejection is a
 * run that failed without exiting.
 */
export const adbDouble = {
  version: vi.fn<AdbDoubleCommand>(),
  device: vi.fn<AdbDoubleCommand>(),
};

const bytes = (value: Buffer | string | undefined): Buffer =>
  Buffer.isBuffer(value) ? value : Buffer.from(value ?? "");

/** Replaces `runAdbProcess` through `vi.mock` of `src/adb/AdbProcess.js`. */
export const runAdbProcessDouble = async (
  _host: unknown,
  arguments_: readonly string[],
): Promise<AdbRunOutcome> => {
  const command =
    arguments_[0] === "version" ? adbDouble.version : adbDouble.device;
  try {
    const run = await command(arguments_);
    const stdout = bytes(run.stdout);
    const stderr = bytes(run.stderr);
    const exitCode = run.exitCode ?? 0;
    return {
      ok: true,
      run: {
        stdout,
        stderr: stderr.toString("utf8"),
        exitCode,
        capturedOutput: {
          stdout: stdout.toString("utf8"),
          stderr: stderr.toString("utf8"),
          stdout_bytes: stdout.byteLength,
          stderr_bytes: stderr.byteLength,
          exit_code: exitCode,
          signal: null,
          truncated: false,
        },
      },
    };
  } catch (cause: unknown) {
    const commandFailure =
      cause instanceof OwnedCommandFailure ? cause : undefined;
    const exited =
      commandFailure?.snapshot?.exitCode !== null &&
      commandFailure?.snapshot?.exitCode !== undefined
        ? {
            stdout: Buffer.from(commandFailure.snapshot.stdout.text),
            stderr: commandFailure.snapshot.stderr.text,
            exitCode: commandFailure.snapshot.exitCode,
            capturedOutput: {
              stdout: commandFailure.snapshot.stdout.text,
              stderr: commandFailure.snapshot.stderr.text,
              stdout_bytes: commandFailure.snapshot.stdout.observedBytes,
              stderr_bytes: commandFailure.snapshot.stderr.observedBytes,
              exit_code: commandFailure.snapshot.exitCode,
              signal: null,
              truncated: false,
            },
          }
        : undefined;
    return {
      ok: false,
      failure: {
        cause,
        command: commandFailure,
        launch: undefined,
        capturedOutput: exited?.capturedOutput,
        exited,
      },
    };
  }
};
