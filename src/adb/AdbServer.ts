import type { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisProtocolError,
  AnalysisTimeoutError,
  cancelledBy,
  carriedReason,
} from "../domain/analysisErrorCore.js";
import { err, ok, type Result } from "../domain/result.js";
import { classifyLaunchFailure } from "../process/classifyProviderOutcome.js";
import {
  execFileFailureCapturedOutput,
  execFileOutput,
  ExecFileOutputCancelledError,
  execFileOutputFailure,
} from "../process/ExecFileOutput.js";
import { launcherFailureOf } from "../process/launchFailure.js";
import { ADB_BINARY_ENV, type AdbBinarySelection } from "./AdbConfiguration.js";
import { isSuccessfulDaemonStartNotice } from "./AdbDeviceOutput.js";

const START_SERVER_TIMEOUT_MS = 30_000;
const START_SERVER_MAX_OUTPUT_BYTES = 64 * 1024;

const hasSuccessfulDaemonStartNotice = (output: string): boolean =>
  output
    .split(/\r?\n/u)
    .some((rawLine) => isSuccessfulDaemonStartNotice(rawLine.trimEnd()));

/**
 * Make sure the adb server is running before device commands, with an
 * explicit `adb start-server`.
 *
 * The adb server is an external shared service: other tools on this host use
 * it, and REA never stops it. REA may start it here. Only the `start-server`
 * client is supervised; the server it forks leaves the client's process group
 * and session, so neither this step nor a device command's owned cleanup
 * signals it. A server that is already running is left as it is.
 */
export const startAdbServer = async (
  operation: string,
  selection: AdbBinarySelection,
  signal: AbortSignal | undefined,
): Promise<Result<{ readonly daemonStarted: boolean }, AnalysisError>> => {
  try {
    const { stdout, stderr } = await execFileOutput(
      selection.binary,
      ["start-server"],
      {
        env: selection.environment,
        timeout: START_SERVER_TIMEOUT_MS,
        maxBuffer: START_SERVER_MAX_OUTPUT_BYTES,
        stopSignal: "SIGTERM",
        ...(signal === undefined ? {} : { signal }),
      },
    );
    return ok({
      daemonStarted:
        hasSuccessfulDaemonStartNotice(stdout) ||
        hasSuccessfulDaemonStartNotice(stderr),
    });
  } catch (cause: unknown) {
    const failure = execFileOutputFailure(cause);
    const observed = {
      diagnostics: { adb_step: "start-server" },
      ...(failure === undefined
        ? {}
        : { capturedOutput: execFileFailureCapturedOutput(failure) }),
    };
    if (cause instanceof ExecFileOutputCancelledError)
      return err(cancelledBy(operation, carriedReason(cause.cause), observed));
    const detail = { cause, ...observed };
    if (failure?.code === "ETIMEDOUT")
      return err(
        new AnalysisTimeoutError(operation, START_SERVER_TIMEOUT_MS, {
          ...detail,
          userMessage: `adb start-server reached its ${String(START_SERVER_TIMEOUT_MS)} ms deadline (deadlineExpired). This release has no runtime override.`,
        }),
      );
    const launch = launcherFailureOf(cause);
    if (launch?.kind === "host-exhausted" || launch?.kind === "argument-list")
      return err(
        classifyLaunchFailure(launch, {
          providerId: "adb",
          operation,
          command: selection.binary,
          fixedArguments: true,
          selection: ADB_BINARY_ENV,
          details: detail,
        }),
      );
    const stderr = failure?.stderr.trim().slice(0, 512) ?? "";
    return err(
      new AnalysisProtocolError(
        stderr === ""
          ? `adb could not start the adb server for ${operation}`
          : `adb could not start the adb server for ${operation}: ${stderr}`,
        detail,
      ),
    );
  }
};
