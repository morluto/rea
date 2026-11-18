import {
  AnalysisProtocolError,
  AnalysisResourceConstraintError,
  AnalysisTimeoutError,
  AnalysisUnsupportedTargetError,
  cancelledBy,
} from "../domain/analysisErrorCore.js";
import {
  primaryAnalysisError,
  type AnalysisError,
} from "../domain/analysisErrorBase.js";
import { ellipsisExcerpt } from "../domain/excerpt.js";
import { fixedAllowanceOptions } from "../domain/fixedAllowanceRemediation.js";
import { err, ok, type Result } from "../domain/result.js";
import { errorMessage } from "../kernel/errorMessage.js";
import {
  adbRunFailureError,
  runAdbProcess,
  type AdbCommandHost,
  type AdbExitedRun,
  type AdbRunFailure,
} from "./AdbProcess.js";
import { classifyLaunchFailure } from "../process/classifyProviderOutcome.js";
import { packageChangeFailureReason } from "./AdbShellOutput.js";
import {
  isSuccessfulDaemonStartNotice,
  isDaemonStartingNotice,
  hasOnlySuccessfulAdbStartupNotices,
} from "./AdbDeviceOutput.js";
import { ADB_BINARY_ENV } from "./AdbConfiguration.js";

const STDERR_EXCERPT_CHARACTERS = 512;

// Match the known host operand in adb's local-file diagnostics. The suffix is
// part of the format: opening/reading identify local failures explicitly.
const LOCAL_FILE_DIAGNOSTICS = [
  ["cannot create", ":"],
  ["cannot create file/directory", ":"],
  ["cannot stat", ":"],
  ["cannot open", ":"],
  ["cannot write", ":"],
  ["failed to stat local file", ":"],
  ["failed to read all of", ":"],
  ["failed to access", ":"],
  ["failed to stat", ":"],
  ["failed to open", ":"],
  ["opening", " locally failed:"],
  ["reading", " locally failed:"],
] as const;

/** adb's own nonzero exit, kept for consumers that read its verdict. */
class AdbProtocolError extends AnalysisProtocolError {
  constructor(
    message: string,
    readonly run: AdbExitedRun,
  ) {
    super(message, { capturedOutput: run.capturedOutput });
  }
}

/** The completed run behind a nonzero adb exit reported here. */
export const adbExitedRunOf = (
  error: AnalysisError,
): AdbExitedRun | undefined => {
  const primary = primaryAnalysisError(error);
  return primary instanceof AdbProtocolError ? primary.run : undefined;
};

/** adb joins shell operands into a remote POSIX command; quote at that boundary. */
const quoteShellOperand = (value: string): string =>
  /^[A-Za-z0-9_./:=@+,-]+$/u.test(value)
    ? value
    : "'" + value.replaceAll("'", "'\\''") + "'";

export const adbArguments = (
  serial: string | undefined,
  arguments_: readonly string[],
): readonly string[] => {
  const operands =
    arguments_[0] === "shell"
      ? ["shell", ...arguments_.slice(1).map(quoteShellOperand)]
      : [...arguments_];
  return serial === undefined ? operands : ["-s", serial, ...operands];
};

export interface AdbRunLimits {
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  /**
   * Live device observations can shrink between calls. Mutation commands omit
   * this so a truncated result stays non-retryable.
   */
  readonly volatileOutput?: boolean;
}

/** Keep the selected device separate from the file addressed by the command. */
export interface AdbCommandTarget {
  readonly device: string;
  /** Caller-addressed file, such as a remote path or the original APK input. */
  readonly path?: string;
  /** Exact host operand adb consumes, including an owned input snapshot. */
  readonly localPath?: string;
}

/** Run one bounded adb invocation and keep its exact failure shape. */
export const runAdbCapture = async (
  operation: string,
  target: AdbCommandTarget,
  host: AdbCommandHost,
  arguments_: readonly string[],
  limits: AdbRunLimits,
  signal: AbortSignal | undefined,
  classifyExit: (run: AdbExitedRun) => AnalysisError | undefined = (run) =>
    run.exitCode === 0 ? undefined : adbExitFailure(operation, target, run),
): Promise<Result<{ stdout: Buffer; stderr: string }, AnalysisError>> => {
  if (signal?.aborted === true) return err(cancelledBy(operation, signal));
  const started = await host.startServer?.();
  if (started !== undefined && !started.ok) return started;
  const outcome = await runAdbProcess(host, arguments_, limits, signal);
  if (!outcome.ok)
    return err(
      adbRunFailureError(operation, host, outcome.failure, (failure) =>
        failure.exited === undefined
          ? adbRunFailure(operation, host, limits, failure)
          : classifyExit(failure.exited),
      ),
    );
  const { run } = outcome;
  const exitFailure = classifyExit(run);
  if (exitFailure === undefined)
    return ok({ stdout: run.stdout, stderr: run.stderr });
  return err(exitFailure);
};

/** adb did not exit on its own: it ran out of time or capture, or never started. */
const adbRunFailure = (
  operation: string,
  host: AdbCommandHost,
  limits: AdbRunLimits,
  failure: AdbRunFailure,
): AnalysisError => {
  const detail = {
    cause: failure.cause,
    ...(failure.capturedOutput === undefined
      ? {}
      : { capturedOutput: failure.capturedOutput }),
  };
  if (failure.command?.reason === "output-limit") {
    const name = `The adb output capture allowance of ${String(limits.maxOutputBytes)} bytes (this release has no runtime override)`;
    const facts = { limit: limits.maxOutputBytes, unit: "bytes" };
    const allowance =
      limits.volatileOutput === true
        ? {
            fixedAllowance: { name, kind: "live" as const, ...facts },
            retryable: true as const,
          }
        : fixedAllowanceOptions(name, "capture", facts);
    return new AnalysisResourceConstraintError(
      operation,
      "memory",
      `adb output exceeded the ${String(limits.maxOutputBytes)}-byte capture budget`,
      { max_output_bytes: limits.maxOutputBytes },
      { ...detail, ...allowance },
    );
  }
  if (failure.command?.reason === "timeout")
    return new AnalysisTimeoutError(operation, limits.timeoutMs, {
      ...detail,
      userMessage: `adb ${operation} reached its ${String(limits.timeoutMs)} ms deadline (deadlineExpired). This release has no runtime override.`,
      remediationAction: `This ${String(limits.timeoutMs)} ms adb deadline has no runtime override. Allow execution, cleanup and delivery headroom in the outer MCP client deadline. Confirm outstanding work and cleanup before retrying.`,
    });
  // The host, not adb, refused this launch: it lacked capacity, or the
  // request's arguments and the environment exceed the launch limit.
  const { launch } = failure;
  if (launch?.kind === "host-exhausted" || launch?.kind === "argument-list")
    return classifyLaunchFailure(launch, {
      providerId: "adb",
      operation,
      command: host.binary,
      selection: ADB_BINARY_ENV,
      details: detail,
    });
  return new AnalysisProtocolError(
    launch !== undefined
      ? `adb could not be started (${String(launch.code ?? "no system code")}) for ${operation}`
      : `adb failed for ${operation}: ${errorMessage(failure.cause)}`,
    detail,
  );
};

/** Read adb's verdict from a run that exited nonzero. */
export const adbExitFailure = (
  operation: string,
  target: AdbCommandTarget,
  run: AdbExitedRun,
): AnalysisError => {
  const detail = { capturedOutput: run.capturedOutput };
  const stderr = run.stderr.trim();
  const excerpt = ellipsisExcerpt(stderr, STDERR_EXCERPT_CHARACTERS);
  // Device-state words inside a reported file name are not device verdicts.
  // Only leading notices need line parsing. Do not expand a capture-sized
  // stderr into an array whose entries can exceed the byte capture budget.
  let diagnosticStart = 0;
  while (diagnosticStart < stderr.length) {
    const newline = stderr.indexOf("\n", diagnosticStart);
    const line = stderr
      .slice(diagnosticStart, newline === -1 ? stderr.length : newline)
      .trimEnd();
    if (!isSuccessfulDaemonStartNotice(line) && !isDaemonStartingNotice(line))
      break;
    diagnosticStart = newline === -1 ? stderr.length : newline + 1;
  }
  const diagnostic = stderr
    .slice(diagnosticStart)
    .replace(
      /^(?:adb:\s*)?(?:error:\s*)?(?:(?:failed to get feature set|connect failed):\s*)?/iu,
      "",
    );
  if (
    /^(?:unauthorized\b|device(?: '[^'\n]*')? (?:unauthorized\b|offline\b|not found\b|still authorizing\b)|still authorizing\b|more than one device\b)/iu.test(
      diagnostic,
    )
  )
    return new AnalysisUnsupportedTargetError(
      operation,
      target.device,
      excerpt,
      detail,
    );
  if (
    /No such file or directory|Permission denied|read: Permission denied/iu.test(
      diagnostic,
    )
  ) {
    const localPath = target.localPath;
    const path =
      localPath !== undefined &&
      LOCAL_FILE_DIAGNOSTICS.some(([verb, suffix]) =>
        [localPath, `'${localPath}'`, `"${localPath}"`].some((operand) =>
          diagnostic.startsWith(`${verb} ${operand}${suffix}`),
        ),
      )
        ? localPath
        : (target.path ?? target.device);
    return new AnalysisUnsupportedTargetError(operation, path, excerpt, detail);
  }
  const protocolError = new AdbProtocolError(
    excerpt === ""
      ? `adb exited with code ${String(run.exitCode)} for ${operation}`
      : excerpt,
    run,
  );
  if (
    operation === "install_adb_package" ||
    operation === "uninstall_adb_package"
  ) {
    const reason = packageChangeFailureReason(
      `${run.capturedOutput.stdout}\n${run.stderr}`,
    );
    if (reason !== null)
      return new AnalysisUnsupportedTargetError(
        operation,
        target.device,
        reason,
        { cause: protocolError },
      );
  }
  return protocolError;
};

/** Decode textual adb protocols after the shared byte capture and error boundary. */
export const runAdb = async (
  ...arguments_: Parameters<typeof runAdbCapture>
): Promise<
  Result<{ stdout: string; stderr: string; stdoutBytes: number }, AnalysisError>
> => {
  const captured = await runAdbCapture(...arguments_);
  if (!captured.ok) return captured;
  return ok({
    stdout: captured.value.stdout.toString("utf8"),
    stderr: captured.value.stderr,
    // Byte count of the captured output before UTF-8 decoding, so malformed
    // sequences replaced by U+FFFD still report their true captured size.
    stdoutBytes: captured.value.stdout.byteLength,
  });
};

/**
 * adb exits nonzero when the device refuses a package change, printing the
 * `Failure [...]` verdict to stderr (install) or stdout (uninstall). Read the
 * refusal from that failed run so it is not reported as unreadable output.
 */
export const packageChangeRefusal = (
  operation: string,
  serial: string,
  error: AnalysisError,
): Result<never, AnalysisError> | undefined => {
  const run = adbExitedRunOf(error);
  if (run === undefined) return undefined;
  const reason = packageChangeFailureReason(
    `${run.capturedOutput.stdout}\n${run.stderr}`,
  );
  return reason === null
    ? undefined
    : err(
        new AnalysisUnsupportedTargetError(operation, serial, reason, {
          cause: error,
        }),
      );
};

/** Parsed predicate and the complete output that supports it. */
export interface AdbPathProbe {
  readonly matches: boolean;
  readonly capturedOutput: {
    readonly stdout: string;
    readonly stderr: string;
    readonly stdout_bytes: number;
    readonly stderr_bytes: number;
    readonly exit_code: 0 | 1;
    readonly signal: null;
    readonly truncated: false;
  };
}
const completedAdbPathProbe = (
  matches: boolean,
  stderr: string,
): AdbPathProbe => ({
  matches,
  capturedOutput: {
    stdout: "",
    stderr,
    stdout_bytes: 0,
    stderr_bytes: Buffer.byteLength(stderr),
    exit_code: matches ? 0 : 1,
    signal: null,
    truncated: false,
  },
});
const recognizedProbeStderr = (stderr: string): boolean =>
  stderr === "" || hasOnlySuccessfulAdbStartupNotices(stderr);

/** Only a complete false predicate, with no device diagnostics, establishes absence. */
export const probeAdbPathExistence = async (
  operation: string,
  serial: string,
  path: string,
  host: AdbCommandHost,
  limits: AdbRunLimits,
  signal: AbortSignal | undefined,
): Promise<Result<AdbPathProbe, AnalysisError>> => {
  return probeAdbPath(operation, serial, path, host, limits, signal, "-e");
};

/** Completed predicate status is independent of recognized host startup notices. */
export const probeAdbPathDirectory = async (
  operation: string,
  serial: string,
  path: string,
  host: AdbCommandHost,
  limits: AdbRunLimits,
  signal: AbortSignal | undefined,
): Promise<Result<AdbPathProbe, AnalysisError>> =>
  probeAdbPath(operation, serial, path, host, limits, signal, "-d");

const probeAdbPath = async (
  operation: string,
  serial: string,
  path: string,
  host: AdbCommandHost,
  limits: AdbRunLimits,
  signal: AbortSignal | undefined,
  predicate: "-d" | "-e",
): Promise<Result<AdbPathProbe, AnalysisError>> => {
  const fact =
    predicate === "-d" ? "destination_directory" : "destination_existence";
  let exitCode = 0;
  const probed = await runAdbCapture(
    operation,
    { device: serial, path },
    host,
    adbArguments(serial, ["shell", "test", predicate, path]),
    { ...limits, volatileOutput: true },
    signal,
    (run) => {
      exitCode = run.exitCode;
      if (
        (run.exitCode === 0 || run.exitCode === 1) &&
        run.stdout.length === 0 &&
        recognizedProbeStderr(run.stderr)
      )
        return undefined;
      if (run.exitCode === 0)
        return new AnalysisProtocolError(
          `The ADB path ${predicate === "-d" ? "directory" : "existence"} probe returned unexpected output; destination status is unknown`,
          {
            diagnostics: { [fact]: "unknown" },
            capturedOutput: run.capturedOutput,
          },
        );
      const failure = adbExitFailure(operation, { device: serial, path }, run);
      return !(failure instanceof AdbProtocolError)
        ? failure
        : new AnalysisProtocolError(failure.message, {
            cause: failure,
            diagnostics: { [fact]: "unknown" },
            capturedOutput: run.capturedOutput,
          });
    },
  );
  if (!probed.ok) return probed;
  return ok(completedAdbPathProbe(exitCode === 0, probed.value.stderr));
};
