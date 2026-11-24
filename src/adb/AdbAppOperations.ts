import type { AnalysisCapturedOutput } from "../domain/analysisErrorBase.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisOutputError,
  AnalysisUnsupportedTargetError,
} from "../domain/analysisErrorCore.js";
import {
  adbResultSchemas,
  type AdbActivityStartPartialObservation,
} from "../domain/adb/adbDeviceAnalysis.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  createAnalysisExecution,
  type AnalysisExecution,
} from "../ports/AnalysisProvider.js";
import {
  adbArguments,
  adbExitedRunOf,
  adbExitFailure,
  packageChangeRefusal,
  runAdb,
} from "./AdbCommand.js";
import type { AdbCommandHost } from "./AdbProcess.js";
import {
  parseAmStartOutput,
  parsePackageChangeOutput,
  parseResolveActivityOutput,
} from "./AdbShellOutput.js";
import type {
  AdbClientResult,
  AdbProviderIdentity,
} from "./AdbOperationResults.js";

const SHELL_TIMEOUT_MS = 30_000;
const PACKAGE_LIST_TIMEOUT_MS = 60_000;
const PM_PATH_MAX_OUTPUT_BYTES = 64 * 1024;
const PULL_MAX_OUTPUT_BYTES = 1024 * 1024;

export const uninstallAdbPackageOperation = async (
  operation: "uninstall_adb_package",
  selection: AdbCommandHost,
  client: AdbClientResult,
  provider: AdbProviderIdentity,
  input: { readonly serial: string; readonly package: string },
  signal: AbortSignal | undefined,
): Promise<Result<AnalysisExecution, AnalysisError>> => {
  const uninstalled = await runAdb(
    operation,
    { device: input.serial },
    selection,
    adbArguments(input.serial, [
      "shell",
      "pm",
      "uninstall",
      "--user",
      "0",
      input.package,
    ]),
    {
      timeoutMs: PACKAGE_LIST_TIMEOUT_MS,
      maxOutputBytes: PULL_MAX_OUTPUT_BYTES,
    },
    signal,
  );
  if (!uninstalled.ok)
    return (
      packageChangeRefusal(operation, input.serial, uninstalled.error) ??
      uninstalled
    );
  const verdict = parsePackageChangeOutput(uninstalled.value.stdout);
  if (verdict.status === "unknown")
    return err(
      new AnalysisOutputError(operation, "ADB returned no removal verdict", {
        capturedOutput: {
          stdout: uninstalled.value.stdout,
          stderr: uninstalled.value.stderr,
          truncated: false,
        },
      }),
    );
  if (verdict.status === "failure")
    return err(
      new AnalysisUnsupportedTargetError(
        operation,
        input.serial,
        verdict.reason,
      ),
    );
  return ok(
    createAnalysisExecution(
      {
        client,
        serial: input.serial,
        package_name: input.package,
      },
      provider,
      {
        limitations: [
          "Uninstall explicitly requests user 0 without data retention (-k); device enforcement is not independently verified",
        ],
      },
    ),
  );
};

export const startAdbAppOperation = async (
  operation: "start_adb_app",
  selection: AdbCommandHost,
  client: AdbClientResult,
  provider: AdbProviderIdentity,
  input: { readonly serial: string; readonly package: string },
  signal: AbortSignal | undefined,
): Promise<Result<AnalysisExecution, AnalysisError>> => {
  const resolved = await runAdb(
    operation,
    { device: input.serial },
    selection,
    adbArguments(input.serial, [
      "shell",
      "cmd",
      "package",
      "resolve-activity",
      "--brief",
      "-c",
      "android.intent.category.LAUNCHER",
      input.package,
    ]),
    {
      timeoutMs: SHELL_TIMEOUT_MS,
      maxOutputBytes: PM_PATH_MAX_OUTPUT_BYTES,
      volatileOutput: true,
    },
    signal,
  );
  if (!resolved.ok) return resolved;
  const component = parseResolveActivityOutput(resolved.value.stdout);
  if (component === null)
    return err(
      new AnalysisUnsupportedTargetError(
        operation,
        input.serial,
        `No launcher activity is declared for ${input.package}`,
      ),
    );
  return runAmStart(
    operation,
    selection,
    client,
    provider,
    input.serial,
    ["-n", component],
    {
      client,
      serial: input.serial,
      package_name: input.package,
      component,
    },
    signal,
  );
};

export const startAdbActivityOperation = async (
  operation: "start_adb_activity",
  selection: AdbCommandHost,
  client: AdbClientResult,
  provider: AdbProviderIdentity,
  input: {
    readonly serial: string;
    readonly action: string;
    readonly data_uri?: string | undefined;
    readonly component?: string | undefined;
    readonly extras: readonly {
      readonly key: string;
      readonly type: "string" | "boolean" | "int" | "long" | "float";
      readonly value: string;
    }[];
  },
  signal: AbortSignal | undefined,
): Promise<Result<AnalysisExecution, AnalysisError>> => {
  const extraFlags: Record<
    "string" | "boolean" | "int" | "long" | "float",
    string
  > = {
    string: "--es",
    boolean: "--ez",
    int: "--ei",
    long: "--el",
    float: "--ef",
  };
  const arguments_ = [
    "-a",
    input.action,
    ...(input.data_uri === undefined ? [] : ["-d", input.data_uri]),
    ...(input.component === undefined ? [] : ["-n", input.component]),
    ...input.extras.flatMap((extra) => [
      extraFlags[extra.type],
      extra.key,
      // Android decodes --ei with Integer.decode, whose leading zero is octal.
      // Encode decimal intent at this boundary; Evidence retains caller text.
      extra.type === "int"
        ? extra.value.replace(/^(-?)0+(?=\d)/u, "$1")
        : extra.value,
    ]),
  ];
  return runAmStart(
    operation,
    selection,
    client,
    provider,
    input.serial,
    arguments_,
    {
      client,
      serial: input.serial,
      action: input.action,
      data_uri: input.data_uri ?? null,
      component: input.component ?? null,
      extras: input.extras.map((extra) => ({ ...extra })),
    },
    signal,
  );
};

const runAmStart = async (
  operation: "start_adb_app" | "start_adb_activity",
  selection: AdbCommandHost,
  _client: AdbClientResult,
  provider: AdbProviderIdentity,
  serial: string,
  arguments_: readonly string[],
  resultFields: Record<string, unknown>,
  signal: AbortSignal | undefined,
): Promise<Result<AnalysisExecution, AnalysisError>> => {
  const buildActivityObservation = (
    verdict: ReturnType<typeof parseAmStartOutput>,
  ): {
    readonly result: Record<string, unknown>;
    readonly partialObservation: AdbActivityStartPartialObservation;
  } => {
    const result = {
      ...resultFields,
      started_activity: verdict.startedActivity,
      reported_activity: verdict.activity,
      reported_status: verdict.reportedStatus,
    };
    return {
      result,
      partialObservation:
        operation === "start_adb_app"
          ? {
              provider_id: "adb",
              operation,
              result: adbResultSchemas.start_adb_app.parse(result),
            }
          : {
              provider_id: "adb",
              operation,
              result: adbResultSchemas.start_adb_activity.parse(result),
            },
    };
  };
  const started = await runAdb(
    operation,
    { device: serial },
    selection,
    adbArguments(serial, ["shell", "am", "start", "-W", ...arguments_]),
    { timeoutMs: SHELL_TIMEOUT_MS, maxOutputBytes: PM_PATH_MAX_OUTPUT_BYTES },
    signal,
    (run) => {
      if (run.exitCode === 0) return undefined;
      const failure = adbExitFailure(operation, { device: serial }, run);
      // AOSP ActivityManagerShellCommand returns 1 for class-not-found and
      // emits its refusal report on stdout. Other exits remain command errors.
      if (adbExitedRunOf(failure) === undefined || run.exitCode !== 1)
        return failure;
      // Stderr carries adb transport diagnostics, not the Activity Manager
      // report, so it cannot establish a target refusal on this path.
      const verdict = parseAmStartOutput(run.capturedOutput.stdout);
      if (verdict.status !== "refused" || verdict.startedActivity === null)
        return failure;
      const { partialObservation } = buildActivityObservation(verdict);
      return new AnalysisUnsupportedTargetError(
        operation,
        serial,
        verdict.reason ?? "am start refused the intent",
        { capturedOutput: run.capturedOutput, partialObservation },
      );
    },
  );
  if (!started.ok) return started;
  const stdout = started.value.stdout;
  const stderr = started.value.stderr;
  const capturedOutput: AnalysisCapturedOutput = {
    stdout,
    stderr,
    truncated: false,
  };
  const verdict = parseAmStartOutput(stdout, stderr);
  const { result, partialObservation } = buildActivityObservation(verdict);
  if (verdict.status === "refused") {
    return err(
      new AnalysisUnsupportedTargetError(
        operation,
        serial,
        verdict.reason ?? "am start refused the intent",
        { capturedOutput, partialObservation },
      ),
    );
  }
  return ok(
    createAnalysisExecution(result, provider, {
      rawResult: {
        stdout,
        stderr,
      },
      limitations: [
        "Starting an activity changes device state; am start -W waits for launch completion but no lifecycle observation is captured",
      ],
    }) as AnalysisExecution,
  );
};

export const stopAdbAppOperation = async (
  operation: "stop_adb_app",
  selection: AdbCommandHost,
  client: AdbClientResult,
  provider: AdbProviderIdentity,
  input: { readonly serial: string; readonly package: string },
  signal: AbortSignal | undefined,
): Promise<Result<AnalysisExecution, AnalysisError>> => {
  const stopped = await runAdb(
    operation,
    { device: input.serial },
    selection,
    adbArguments(input.serial, ["shell", "am", "force-stop", input.package]),
    { timeoutMs: SHELL_TIMEOUT_MS, maxOutputBytes: PM_PATH_MAX_OUTPUT_BYTES },
    signal,
  );
  if (!stopped.ok) return stopped;
  return ok(
    createAnalysisExecution(
      {
        client,
        serial: input.serial,
        package_name: input.package,
      },
      provider,
      {
        limitations: [
          "Force-stop succeeds even for packages with no running process; it reports completion, not prior state",
        ],
      },
    ),
  );
};
