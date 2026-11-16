import { randomUUID } from "node:crypto";

import {
  AnalysisError,
  type AnalysisCapturedOutput,
} from "../domain/analysisErrorBase.js";
import { analysisErrorWithCleanupDependencies } from "../domain/analysisErrorCleanup.js";
import { cancelledBy, carriedReason } from "../domain/analysisErrorCore.js";
import { capturedProviderOutput } from "../process/capturedProviderOutput.js";
import { DarwinProcessOwnershipInspectionError } from "../process/DarwinProcessRunTokenReader.js";
import {
  launcherFailureOf,
  type LauncherFailure,
} from "../process/launchFailure.js";
import {
  OwnedCommandFailure,
  OwnedCommandStdoutBytes,
  prepareOwnedCommand,
  preparationHostCapacityFailure,
  runOwnedCommand,
} from "../process/OwnedCommand.js";
import type {
  ProcessTerminationPolicy,
  ProviderProcessSnapshot,
} from "../process/ProviderProcess.js";
import {
  bindProcessInspectionCancellations,
  processInspectionCancellationError,
  processInspectionFailure,
  retainArtifactCommandCleanup,
} from "../providers/OwnedCommandCleanup.js";
import type { ArtifactResourceScope } from "../resources/index.js";
import type { AdbBinarySelection } from "./AdbConfiguration.js";

/**
 * The selected adb binary and the scope that keeps an adb command whose
 * cleanup failed, so the provider retries it before its next operation.
 */
export interface AdbCommandHost extends AdbBinarySelection {
  readonly resources: ArtifactResourceScope;
  /** Replaces the owned launcher, for tests that control process outcomes. */
  readonly launcher?: NonNullable<
    Parameters<typeof runOwnedCommand>[2]
  >["launcher"];
}

/**
 * adb is asked to stop before its process group is killed, as it was before
 * owned supervision, so it can close its server connection.
 */
const ADB_TERMINATION: ProcessTerminationPolicy = {
  signal: "SIGTERM",
  graceMs: 5_000,
};

/** An adb run that exited on its own, with its status and complete output. */
export interface AdbExitedRun {
  readonly stdout: Buffer;
  readonly stderr: string;
  readonly exitCode: number;
  readonly capturedOutput: AnalysisCapturedOutput;
}

/** Why an adb run did not exit on its own, with the facts it left. */
export interface AdbRunFailure {
  readonly cause: unknown;
  readonly command: OwnedCommandFailure | undefined;
  /** The host refused to start adb; no adb process ran. */
  readonly launch: LauncherFailure | undefined;
  readonly capturedOutput: AnalysisCapturedOutput | undefined;
  /** Present when adb exited but its process cleanup did not finish. */
  readonly exited: AdbExitedRun | undefined;
}

export type AdbRunOutcome =
  | { readonly ok: true; readonly run: AdbExitedRun }
  | { readonly ok: false; readonly failure: AdbRunFailure };

const exitedRun = (
  snapshot: ProviderProcessSnapshot,
  stdout: Buffer,
  exitCode: number,
): AdbExitedRun => ({
  stdout,
  stderr: snapshot.stderr.text,
  exitCode,
  capturedOutput: {
    stdout: stdout.toString("utf8"),
    stderr: snapshot.stderr.text,
    stdout_bytes: stdout.byteLength,
    stderr_bytes: snapshot.stderr.observedBytes,
    exit_code: exitCode,
    signal: null,
    truncated: false,
  },
});

/** Output an interrupted run left: stdout from the collector, stderr from the supervisor. */
const failureOutput = (
  command: OwnedCommandFailure | undefined,
  cause: unknown,
  stdout: Buffer,
): AnalysisCapturedOutput | undefined => {
  if (command?.snapshot == null) {
    const preparation = processInspectionFailure(cause);
    return preparation instanceof DarwinProcessOwnershipInspectionError
      ? preparation.capturedOutput
      : undefined;
  }
  const observed = capturedProviderOutput(command.snapshot);
  return {
    ...observed,
    // The bytes adb wrote up to its capture limit; `truncated` marks a cut.
    stdout: stdout.toString("utf8"),
    stdout_bytes: stdout.byteLength,
    truncated:
      observed.truncated ||
      command.reason === "output-limit" ||
      command.snapshot.outputIncomplete === true,
  };
};

/**
 * Run one adb command in an owned process group, with its stdout kept as
 * bytes up to `maxOutputBytes`. A nonzero exit is a completed run; the caller
 * reads adb's verdict from it.
 */
export const runAdbProcess = async (
  host: AdbCommandHost,
  arguments_: readonly string[],
  limits: { readonly timeoutMs: number; readonly maxOutputBytes: number },
  signal: AbortSignal | undefined,
): Promise<AdbRunOutcome> => {
  const stdout = new OwnedCommandStdoutBytes();
  let exited: AdbExitedRun | undefined;
  try {
    await prepareOwnedCommand(signal);
    await runOwnedCommand(
      {
        command: host.binary,
        arguments: arguments_,
        runId: `rea-adb-${randomUUID()}`,
        hostEnvironment: host.environment,
        sweepTokenOwnedProcesses: true,
      },
      {
        timeoutMs: limits.timeoutMs,
        diagnosticBytes: limits.maxOutputBytes,
        stdout,
        maxStdoutBytes: limits.maxOutputBytes,
        acceptNonZeroExit: true,
        termination: ADB_TERMINATION,
        observeCompleted: (snapshot) => {
          // An accepted run exited normally, so it has a numeric status.
          if (typeof snapshot.exitCode === "number")
            exited = exitedRun(snapshot, stdout.bytes, snapshot.exitCode);
        },
      },
      {
        signal,
        ...(host.launcher === undefined ? {} : { launcher: host.launcher }),
      },
    );
    if (exited === undefined)
      throw new OwnedCommandFailure(
        "process",
        "adb completed without an exit status",
      );
    return { ok: true, run: exited };
  } catch (cause: unknown) {
    const command = cause instanceof OwnedCommandFailure ? cause : undefined;
    return {
      ok: false,
      failure: {
        cause,
        command,
        launch:
          launcherFailureOf(command?.processError ?? cause) ??
          preparationHostCapacityFailure(cause),
        capturedOutput: failureOutput(command, cause, stdout.bytes),
        exited: command?.cleanupOwner === undefined ? undefined : exited,
      },
    };
  }
};

/**
 * Report a failed adb run: caller cancellation and interrupted process
 * inspection first, then `classify` for the run's own failure. Process and
 * inspection owners whose cleanup failed move to the host's scope; when adb
 * had exited, that cleanup failure is the report and keeps adb's output.
 */
export const adbRunFailureError = (
  operation: string,
  host: AdbCommandHost,
  failure: AdbRunFailure,
  classify: (failure: AdbRunFailure) => AnalysisError,
): AnalysisError => {
  const { cause, command } = failure;
  const cleanups = retainArtifactCommandCleanup(
    cause,
    host.resources,
    operation,
    failure.exited === undefined
      ? undefined
      : { capturedOutput: failure.exited.capturedOutput },
  );
  const inspectionCancellation =
    command === undefined || command.preparationFailure !== undefined
      ? processInspectionCancellationError(cause, operation)
      : undefined;
  let primary: AnalysisError;
  if (command?.reason === "cancelled" && command.cancellation !== undefined)
    primary =
      inspectionCancellation ??
      cancelledBy(
        operation,
        carriedReason(command.cancellation.reason),
        failure.capturedOutput === undefined
          ? {}
          : { capturedOutput: failure.capturedOutput },
      );
  else if (inspectionCancellation !== undefined)
    primary = inspectionCancellation;
  // Ownership preparation reports its own analysis failure, such as cleanup
  // of an earlier preparation it must finish before admitting another launch.
  else if (command === undefined && cause instanceof AnalysisError)
    primary = cause;
  else if (failure.exited !== undefined && cleanups[0] !== undefined)
    primary = cleanups[0];
  else primary = classify(failure);
  for (const cleanup of cleanups)
    if (cleanup !== primary)
      primary = analysisErrorWithCleanupDependencies(
        primary,
        cleanup,
        operation,
      );
  return bindProcessInspectionCancellations(cause, primary, operation);
};
