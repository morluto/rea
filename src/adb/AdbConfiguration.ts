import {
  AnalysisProtocolError,
  AnalysisResourceConstraintError,
  AnalysisTimeoutError,
  cancelledBy,
  carriedReason,
} from "../domain/analysisErrorCore.js";
import { isQualifiedCallerPath } from "../filesystem/callerPath.js";
import { findWindowsExecutable } from "../process/WindowsExecutable.js";
import { ProviderStartupDeadline } from "../process/ProviderDeadline.js";
import { snapshotEnvironment } from "../process/snapshotEnvironment.js";

import type { ProviderAvailability } from "../ports/AnalysisProvider.js";
import type { ProviderRejectionCode } from "../domain/providerSelection.js";
import { fixedAllowanceOptions } from "../domain/fixedAllowanceRemediation.js";
import type { JsonValue } from "../domain/jsonValue.js";
import type { LauncherFailure } from "../process/launchFailure.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { errorMessage } from "../kernel/errorMessage.js";
import {
  adbRunFailureError,
  runAdbProcess,
  type AdbCommandHost,
  type AdbRunFailure,
} from "./AdbProcess.js";
import { classifyLaunchFailure } from "../process/classifyProviderOutcome.js";

/** Environment key selecting the caller's adb binary. */
export const ADB_BINARY_ENV = "REA_ADB_PATH";

const VERSION_TIMEOUT_MS = 10_000;

const ADB_VERSION_REMEDIATION = `Set ${ADB_BINARY_ENV} to an Android SDK Platform-Tools adb binary whose \`adb version\` reports its version, or put one on PATH.`;
/** Repair when the selected adb binary does not exist. */
const ADB_MISSING_REMEDIATION = `Set ${ADB_BINARY_ENV} to an absolute path to an existing adb binary.`;
/** Repair when execution of the adb binary selected by the environment is denied. */
const ADB_NOT_EXECUTABLE_REMEDIATION = `Set ${ADB_BINARY_ENV} to an absolute path to the adb executable file, not a directory, and check execute permission on it and search permission on its parent directories.`;
const VERSION_MAX_OUTPUT_BYTES = 64 * 1024;

/** How the adb binary was selected for this provider instance. */
export interface AdbBinarySelection {
  readonly binary: string;
  readonly pathSource: "environment" | "path";
  readonly environment: Readonly<Record<string, string | undefined>>;
}

/**
 * Resolve the caller-supplied adb binary. `REA_ADB_PATH` must be absolute so
 * the selection stays explicit. Windows resolves the default from the selected
 * PATH before launch; POSIX retains execFile PATH lookup.
 */
export const resolveAdbBinary = async (
  environment: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
  signal?: AbortSignal,
): Promise<AdbBinarySelection> => {
  const selectedEnvironment = snapshotEnvironment(environment, platform);
  const configured = selectedEnvironment[ADB_BINARY_ENV];
  if (configured === undefined || configured.trim() === "")
    return {
      binary:
        platform === "win32"
          ? await resolveWindowsAdb(selectedEnvironment, signal)
          : "adb",
      pathSource: "path",
      environment: selectedEnvironment,
    };
  if (!isQualifiedCallerPath(configured, platform))
    throw new AdbConfigurationFailure(
      "not_absolute",
      `${ADB_BINARY_ENV} must be an absolute path to the adb binary`,
      `Set ${ADB_BINARY_ENV} to an absolute adb executable path, or unset it to use adb from PATH.`,
      { configured_path: configured },
    );
  return {
    binary: configured,
    pathSource: "environment",
    environment: selectedEnvironment,
  };
};

const resolveWindowsAdb = async (
  environment: Readonly<NodeJS.ProcessEnv>,
  signal?: AbortSignal,
): Promise<string> => {
  const deadline = new ProviderStartupDeadline(VERSION_TIMEOUT_MS, signal);
  try {
    const found = await findWindowsExecutable("adb", environment, {
      signal: deadline.signal,
    });
    if (found.ok) return found.value;
    const failure = found.error;
    if (failure.kind === "interrupted") {
      if (deadline.interruption === "cancelled")
        throw cancelledBy("inspect_adb_client", carriedReason(signal?.reason));
      throw new AnalysisTimeoutError("inspect_adb_client", VERSION_TIMEOUT_MS, {
        diagnostics: { phase: "windows_path_lookup" },
      });
    }
    throw new AdbConfigurationFailure(
      failure.kind === "missing" ? "binary_missing" : "binary_unresolved",
      "The adb binary could not be selected from the Windows PATH/PATHEXT",
      `Set ${ADB_BINARY_ENV} to an absolute adb executable, or add it to PATH/PATHEXT.`,
      {
        selected_binary: "adb",
        path_source: "path",
        ...(failure.kind === "invalid_extension"
          ? { invalid_extension: failure.extension }
          : {}),
        ...(failure.kind === "inspection"
          ? {
              candidate_path: failure.path,
              ...(failure.code === null
                ? {}
                : { filesystem_error: failure.code }),
            }
          : {}),
      },
      failure.kind === "inspection" ? { cause: failure.cause } : undefined,
    );
  } finally {
    deadline.dispose();
  }
};

export type AdbConfigurationFailureCode =
  | "not_absolute"
  | "binary_missing"
  | "binary_unresolved"
  | "binary_not_executable"
  | "version_unresolved";

/** Why the selected adb binary is unusable, with the owner's repair instruction. */
export class AdbConfigurationFailure extends Error {
  constructor(
    readonly code: AdbConfigurationFailureCode,
    message: string,
    readonly remediation: string,
    readonly diagnostics: Readonly<Record<string, JsonValue>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface AdbClientIdentity {
  readonly version: string | null;
  readonly installedPath: string | null;
}

/**
 * Parse `adb version` output. The first line carries the protocol version,
 * `Version ` the build version (no colon), and `Installed as` the binary path.
 */
export const parseAdbVersionOutput = (stdout: string): AdbClientIdentity => {
  const build = /^Version\s+(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\s*$/mu.exec(
    stdout,
  );
  // The literal delimiter and line ending belong to the protocol; path
  // whitespace belongs to the reported executable identity.
  const installed = /^Installed as ([^\n]*)$/mu
    .exec(stdout)?.[1]
    ?.replace(/\r$/u, "");
  return {
    version: build === null ? null : build[1]!.trim(),
    installedPath:
      installed === undefined || installed === "" ? null : installed,
  };
};

/**
 * Probe the selected adb binary without contacting devices. `adb version`
 * never starts the adb server, so this stays a pure client check.
 */
export const inspectAdbClient = async (
  host: AdbCommandHost,
  signal?: AbortSignal,
): Promise<AdbClientIdentity> => {
  const outcome = await runAdbProcess(
    host,
    ["version"],
    { timeoutMs: VERSION_TIMEOUT_MS, maxOutputBytes: VERSION_MAX_OUTPUT_BYTES },
    signal,
  );
  if (!outcome.ok) {
    const failure = outcome.failure;
    // The process never started: the launcher's errno is not an exit status.
    const launch = failure.launch;
    if (
      failure.command === undefined &&
      launch !== undefined &&
      launch.kind !== "host-exhausted" &&
      launch.kind !== "argument-list"
    )
      throw adbLaunchRefusal(host, launch, failure.cause);
    throw adbRunFailureError("inspect_adb_client", host, failure, () =>
      failure.exited === undefined
        ? versionProbeFailure(host, failure)
        : undefined,
    );
  }
  const { run } = outcome;
  const stdout = run.stdout.toString("utf8");
  if (run.exitCode !== 0)
    throw new AdbConfigurationFailure(
      "version_unresolved",
      `The selected adb binary did not report a usable version: ${host.binary}`,
      ADB_VERSION_REMEDIATION,
      {
        selected_binary: host.binary,
        path_source: host.pathSource,
        exit_code: run.exitCode,
        stderr_excerpt: run.stderr.slice(0, 512),
      },
    );
  const identity = parseAdbVersionOutput(stdout);
  const hasRecognizedProtocolVersion =
    /^Android Debug Bridge version\s+\d+\.\d+\.\d+\s*$/mu.test(stdout);
  if (identity.version === null && !hasRecognizedProtocolVersion)
    throw new AdbConfigurationFailure(
      "version_unresolved",
      "The selected adb binary exited successfully but did not report a recognizable protocol or build version",
      ADB_VERSION_REMEDIATION,
      {
        selected_binary: host.binary,
        path_source: host.pathSource,
        version_probe: "unrecognized_output",
        stdout,
        stderr: run.stderr,
      },
    );
  return identity;
};

/** The version probe did not exit on its own. */
const versionProbeFailure = (
  host: AdbCommandHost,
  failure: AdbRunFailure,
): AnalysisError => {
  const facts = {
    selected_binary: host.binary,
    path_source: host.pathSource,
  };
  const options = {
    cause: failure.cause,
    diagnostics: facts,
    ...(failure.capturedOutput === undefined
      ? {}
      : { capturedOutput: failure.capturedOutput }),
  };
  if (failure.command?.reason === "output-limit")
    return new AnalysisResourceConstraintError(
      "inspect_adb_client",
      "memory",
      `adb version output exceeded the ${String(VERSION_MAX_OUTPUT_BYTES)}-byte capture budget`,
      { max_output_bytes: VERSION_MAX_OUTPUT_BYTES },
      {
        ...options,
        ...fixedAllowanceOptions(
          `The adb version-output capture allowance of ${String(VERSION_MAX_OUTPUT_BYTES)} bytes (this release has no runtime override)`,
          "capture",
          { limit: VERSION_MAX_OUTPUT_BYTES, unit: "bytes" },
        ),
      },
    );
  if (failure.command?.reason === "timeout")
    return new AnalysisTimeoutError("inspect_adb_client", VERSION_TIMEOUT_MS, {
      ...options,
      userMessage: `adb version probe reached its ${String(VERSION_TIMEOUT_MS)} ms deadline (deadlineExpired). This release has no runtime override.`,
      remediationAction: `This ${String(VERSION_TIMEOUT_MS)} ms adb version probe has no runtime override. Allow execution, cleanup and delivery headroom in the outer MCP client deadline. Confirm outstanding work and cleanup before retrying.`,
    });
  const launch = failure.launch;
  // The host, not the selected binary, refused this launch.
  if (launch?.kind === "host-exhausted" || launch?.kind === "argument-list")
    return classifyLaunchFailure(launch, {
      providerId: "adb",
      operation: "inspect_adb_client",
      command: host.binary,
      fixedArguments: true,
      selection: ADB_BINARY_ENV,
      details: { cause: failure.cause, diagnostics: facts },
    });
  return new AnalysisProtocolError(
    `adb version probe failed: ${errorMessage(failure.cause)}`,
    options,
  );
};

/** The selected adb binary could not be started: a repair to its selection. */
const adbLaunchRefusal = (
  host: AdbCommandHost,
  launch: LauncherFailure,
  cause: unknown,
): AdbConfigurationFailure => {
  const code = launch.code ?? "no system code";
  const fromEnvironment = host.pathSource === "environment";
  const facts = {
    selected_binary: host.binary,
    path_source: host.pathSource,
    filesystem_error: code,
  };
  // Nothing executable resolves at the selected path.
  if (launch.kind === "missing")
    return new AdbConfigurationFailure(
      "binary_missing",
      `The selected adb binary was not found: ${host.binary}`,
      ADB_MISSING_REMEDIATION,
      facts,
      { cause },
    );
  return new AdbConfigurationFailure(
    "binary_not_executable",
    code === "EACCES" || code === "EPERM"
      ? `Execution of the selected adb binary was denied (${code}): ${host.binary}`
      : `The selected adb binary could not be started (${code}): ${host.binary}`,
    code === "EACCES"
      ? fromEnvironment
        ? ADB_NOT_EXECUTABLE_REMEDIATION
        : `Make sure the adb found on PATH is a file with execute permission, not a directory, and that its parent directories have search permission, or set ${ADB_BINARY_ENV} to an absolute path to an executable adb binary.`
      : code === "EPERM"
        ? `The host refused to run this adb binary, for example because of a security policy or file flags; allow it to run, or set ${ADB_BINARY_ENV} to an absolute path to an adb binary the host permits.`
        : `Select an adb executable this host can start directly: set ${ADB_BINARY_ENV} to its absolute path, or make it the adb found on PATH.`,
    facts,
    { cause },
  );
};

/** Availability in the shape shared by every provider. */
const rejectionCodeOf = (
  code: AdbConfigurationFailureCode,
): ProviderRejectionCode =>
  code === "binary_missing"
    ? "executable_missing"
    : code === "not_absolute" ||
        code === "binary_not_executable" ||
        code === "binary_unresolved"
      ? "not_configured"
      : "version_unresolved";

export const adbConfigurationAvailability = (
  cause: AdbConfigurationFailure,
): ProviderAvailability => ({
  status: "unavailable",
  code: rejectionCodeOf(cause.code),
  reason: cause.message,
  remediation: cause.remediation,
  diagnostics: { ...cause.diagnostics },
});
