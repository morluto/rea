import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, constants as fsConstants } from "node:fs";
import { access, lstat, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import type {
  ExecutionOptions,
  ProviderAvailability,
} from "../application/AnalysisProvider.js";
import {
  createAnalysisExecution,
  type AnalysisExecution,
} from "../application/AnalysisProvider.js";
import type { AdbRequest } from "../domain/adb/adbDeviceAnalysis.js";
import {
  AnalysisArtifactChangedError,
  AnalysisCapabilityUnavailableError,
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
  AnalysisProtocolError,
  AnalysisResourceConstraintError,
  AnalysisTimeoutError,
  AnalysisUnsupportedTargetError,
} from "../domain/analysisErrorCore.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  execFileOutput,
  execFileOutputFailure,
} from "../process/ExecFileOutput.js";
import {
  AdbConfigurationFailure,
  inspectAdbClient,
  resolveAdbBinary,
  type AdbBinarySelection,
  type AdbClientIdentity,
} from "./AdbConfiguration.js";
import {
  parseAdbDevicesOutput,
  parseGetpropOutput,
  parsePackageListOutput,
  parsePmPathOutput,
} from "./AdbDeviceOutput.js";
import {
  parseAmStartOutput,
  parseBugreportCopiedPath,
  parseDumpsysPackageOutput,
  parseFeatureListOutput,
  parseLsOutput,
  parsePackageChangeOutput,
  parseProcessListOutput,
  parsePngDimensions,
  parseResolveActivityOutput,
  parseServiceListOutput,
  parseSettingsGetOutput,
  parseWindowFocusOutput,
  parseWmDensityOutput,
  parseWmSizeOutput,
} from "./AdbShellOutput.js";

/** Stable identity for the ADB device-acquisition provider. */
export const ADB_PROVIDER_IDENTITY = {
  id: "adb",
  name: "Android Debug Bridge",
  version: null,
} as const;

const VERSION_TIMEOUT_MS = 10_000;
const VERSION_MAX_OUTPUT_BYTES = 64 * 1024;
const DEVICES_TIMEOUT_MS = 20_000;
const DEVICES_MAX_OUTPUT_BYTES = 1024 * 1024;
const SHELL_TIMEOUT_MS = 30_000;
const GETPROP_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const PACKAGE_LIST_TIMEOUT_MS = 60_000;
const PACKAGE_LIST_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const PM_PATH_TIMEOUT_MS = 30_000;
const PM_PATH_MAX_OUTPUT_BYTES = 64 * 1024;
const PULL_TIMEOUT_MS = 600_000;
const PULL_MAX_OUTPUT_BYTES = 1024 * 1024;
const LOGCAT_TIMEOUT_MS = 60_000;
const LOGCAT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const DUMPSYS_PACKAGE_TIMEOUT_MS = 60_000;
const DUMPSYS_PACKAGE_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const DUMPSYS_WINDOW_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const LISTING_TIMEOUT_MS = 30_000;
const LISTING_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const SETTINGS_TIMEOUT_MS = 20_000;
const SETTINGS_MAX_OUTPUT_BYTES = 1024 * 1024;
const SCREEN_TIMEOUT_MS = 60_000;
const SCREEN_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const BUGREPORT_TIMEOUT_MS = 600_000;
const BUGREPORT_MAX_OUTPUT_BYTES = 1024 * 1024;
const STDERR_EXCERPT_BYTES = 512;
const UNPARSED_LINES_REPORTED = 10;
const STOP_GRACE_MS = 5_000;

/** Stream a local file digest without retaining large files in memory. */
const sha256File = async (path: string): Promise<string> => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
};

/** adb joins shell operands into a remote POSIX command; quote at that boundary. */
const quoteShellOperand = (value: string): string =>
  /^[A-Za-z0-9_./:=@+,\-]+$/u.test(value)
    ? value
    : "'" + value.replaceAll("'", "'\\''") + "'";

const adbArguments = (
  serial: string | undefined,
  arguments_: readonly string[],
): readonly string[] => {
  const operands =
    arguments_[0] === "shell"
      ? ["shell", ...arguments_.slice(1).map(quoteShellOperand)]
      : [...arguments_];
  return serial === undefined ? operands : ["-s", serial, ...operands];
};

interface AdbRunLimits {
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

/** Run one bounded adb invocation and keep its exact failure shape. */
const runAdb = async (
  operation: string,
  targetPath: string,
  binary: string,
  arguments_: readonly string[],
  limits: AdbRunLimits,
  signal: AbortSignal | undefined,
): Promise<Result<{ stdout: string; stderr: string }, AnalysisError>> => {
  if (signal?.aborted === true)
    return err(new AnalysisCancelledError(operation));
  try {
    return ok(
      await execFileOutput(binary, arguments_, {
        timeout: limits.timeoutMs,
        maxBuffer: limits.maxOutputBytes,
        stopSignal: "SIGTERM",
        ...(signal === undefined ? {} : { signal }),
      }),
    );
  } catch (cause) {
    if (signal?.aborted || execFileOutputFailure(cause)?.code === "ABORT_ERR")
      return err(new AnalysisCancelledError(operation, { cause }));
    const failure = execFileOutputFailure(cause);
    if (failure === undefined)
      return err(
        new AnalysisProtocolError(`adb failed for ${operation}`, { cause }),
      );
    if (failure.outputTruncated)
      return err(
        new AnalysisResourceConstraintError(
          operation,
          "memory",
          `adb output exceeded the ${String(limits.maxOutputBytes)}-byte capture budget`,
          { max_output_bytes: limits.maxOutputBytes },
          { cause },
        ),
      );
    const excerpt = failure.stderr.trim().slice(0, STDERR_EXCERPT_BYTES);
    if (/unauthorized/iu.test(excerpt))
      return err(
        new AnalysisUnsupportedTargetError(operation, targetPath, excerpt, {
          cause,
        }),
      );
    if (
      /device[^\n]*not found|device offline|still authorizing|more than one device/iu.test(
        excerpt,
      )
    )
      return err(
        new AnalysisUnsupportedTargetError(operation, targetPath, excerpt, {
          cause,
        }),
      );
    if (
      /No such file or directory|Permission denied|read: Permission denied/iu.test(
        excerpt,
      )
    )
      return err(
        new AnalysisUnsupportedTargetError(operation, targetPath, excerpt, {
          cause,
        }),
      );
    if (failure.killed)
      return err(
        new AnalysisTimeoutError(operation, limits.timeoutMs, { cause }),
      );
    return err(
      new AnalysisProtocolError(
        excerpt === ""
          ? `adb exited with code ${String(failure.code)} for ${operation}`
          : excerpt,
        { cause },
      ),
    );
  }
};

/** Capture one adb invocation's raw binary stdout (screencap PNG). */
const runAdbBinary = (
  operation: string,
  binary: string,
  arguments_: readonly string[],
  limits: AdbRunLimits,
  signal: AbortSignal | undefined,
): Promise<Result<Buffer, AnalysisError>> =>
  new Promise((settle) => {
    if (signal?.aborted === true)
      return settle(err(new AnalysisCancelledError(operation)));
    let stopped: "abort" | "timeout" | undefined;
    let deadline: NodeJS.Timeout | undefined;
    let grace: NodeJS.Timeout | undefined;
    const child = execFile(
      binary,
      [...arguments_],
      {
        encoding: "buffer" as const,
        maxBuffer: limits.maxOutputBytes,
        killSignal: "SIGTERM",
        timeout: 0,
      },
      (error, stdout) => {
        signal?.removeEventListener("abort", onAbort);
        clearTimeout(deadline);
        clearTimeout(grace);
        if (stopped === "abort")
          return settle(err(new AnalysisCancelledError(operation)));
        if (stopped === "timeout")
          return settle(
            err(new AnalysisTimeoutError(operation, limits.timeoutMs)),
          );
        if (error !== null)
          return settle(
            err(
              new AnalysisProtocolError(
                `adb failed for ${operation}: ${error.message}`,
                { cause: error },
              ),
            ),
          );
        settle(ok(stdout as Buffer));
      },
    );
    const stop = (reason: "abort" | "timeout"): void => {
      if (stopped !== undefined) return;
      stopped = reason;
      child.kill("SIGTERM");
      grace = setTimeout(() => child.kill("SIGKILL"), STOP_GRACE_MS);
    };
    const onAbort = (): void => stop("abort");
    signal?.addEventListener("abort", onAbort, { once: true });
    deadline = setTimeout(() => stop("timeout"), limits.timeoutMs);
  });

const clientIdentityResult = (
  selection: AdbBinarySelection,
  identity: AdbClientIdentity,
) => ({
  binary_path: selection.binary,
  path_source: selection.pathSource,
  version: identity.version,
  installed_path: identity.installedPath,
});

type ClientIdentity = ReturnType<typeof clientIdentityResult>;
type ProviderIdentity = { id: string; name: string; version: string | null };

const reported = (
  unparsedLines: readonly string[],
  coverage: "complete" | "partial",
) => ({
  unparsed_lines: unparsedLines.slice(0, UNPARSED_LINES_REPORTED),
  coverage:
    coverage === "partial" || unparsedLines.length > 0 ? "partial" : "complete",
});

const unparsedOverflowLimitation = (
  unparsedLines: readonly string[],
): string[] =>
  unparsedLines.length > UNPARSED_LINES_REPORTED
    ? [
        `unparsed_lines reports the first ${String(UNPARSED_LINES_REPORTED)} of ${String(unparsedLines.length)} unrecognized lines`,
      ]
    : [];

/** Materialize the caller's output directory, refusing existing files inside. */
const prepareOutputDirectory = async (
  operation: string,
  directory: string,
): Promise<Result<string, AnalysisError>> => {
  const root = resolve(directory);
  try {
    await mkdir(root, { recursive: true });
    await access(root, fsConstants.W_OK);
  } catch (cause) {
    return err(
      new AnalysisOutputError(
        operation,
        `The output directory is not writable or could not be created: ${root}`,
        { cause },
      ),
    );
  }
  return ok(root);
};

const refuseExistingTarget = async (
  operation: string,
  path: string,
): Promise<AnalysisError | undefined> => {
  if (
    await lstat(path).then(
      () => true,
      () => false,
    )
  )
    return new AnalysisOutputError(
      operation,
      `The output file already exists: ${path}`,
    );
  return undefined;
};

export interface AdbProviderOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

/**
 * ADB device inspection and acquisition over a caller-selected adb binary.
 *
 * Every operation composes fixed adb argument vectors: caller values occupy
 * positional arguments, escaped when adb forwards them to the device shell. The provider never
 * starts an emulator, installs platform tools, or drives the device UI; the
 * only device mutation is the caller-requested file push, which requires an
 * explicit overwrite choice and verifies its transfer digest.
 */
export class AdbProvider {
  private readonly environment: Readonly<Record<string, string | undefined>>;

  constructor(options: AdbProviderOptions = {}) {
    this.environment = options.environment ?? process.env;
  }

  private selection(): AdbBinarySelection {
    return resolveAdbBinary(this.environment);
  }

  /** Probe the selected adb binary; never contacts devices or the server. */
  async inspectAvailability(
    signal?: AbortSignal,
  ): Promise<ProviderAvailability> {
    const selection = this.selection();
    try {
      await inspectAdbClient(selection, signal);
      return {
        status: "available",
        code: null,
        reason: null,
        diagnostics: {
          selected_binary: selection.binary,
          path_source: selection.pathSource,
        },
      };
    } catch (cause) {
      if (cause instanceof AdbConfigurationFailure)
        return {
          status: "unavailable",
          code:
            cause.code === "binary_missing"
              ? "executable_missing"
              : cause.code === "not_absolute"
                ? "not_configured"
                : "version_unresolved",
          reason: cause.message,
          diagnostics: { ...cause.diagnostics },
        };
      throw cause;
    }
  }

  /** The provider holds no long-lived resources; the adb server is caller-owned. */
  async close(): Promise<void> {}

  async execute(
    request: AdbRequest,
    options?: ExecutionOptions,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    const signal = options?.signal;
    if (signal?.aborted === true)
      return err(new AnalysisCancelledError(request.operation));
    const selection = this.selection();
    let identity: AdbClientIdentity;
    try {
      identity = await inspectAdbClient(selection, signal);
    } catch (cause) {
      if (cause instanceof AnalysisCancelledError) return err(cause);
      if (cause instanceof AdbConfigurationFailure)
        return err(
          new AnalysisCapabilityUnavailableError(
            ADB_PROVIDER_IDENTITY.id,
            request.operation,
            typeof cause.diagnostics.remediation === "string"
              ? `${cause.message} ${cause.diagnostics.remediation}`
              : cause.message,
            { cause },
          ),
        );
      return err(
        new AnalysisProtocolError(
          `adb version probe failed for ${request.operation}`,
          { cause },
        ),
      );
    }
    const client = clientIdentityResult(selection, identity);
    const provider: ProviderIdentity = {
      ...ADB_PROVIDER_IDENTITY,
      version: identity.version,
    };
    const { operation } = request;
    const shell = (arguments_: readonly string[], limits: AdbRunLimits) =>
      runAdb(
        operation,
        "serial" in request.input ? request.input.serial : operation,
        selection.binary,
        adbArguments(
          "serial" in request.input ? request.input.serial : undefined,
          ["shell", ...arguments_],
        ),
        limits,
        signal,
      );
    switch (operation) {
      case "inspect_adb_client":
        return ok(
          createAnalysisExecution(
            { client, contacted_adb_server: false },
            provider,
          ),
        );
      case "list_adb_devices": {
        const ran = await runAdb(
          operation,
          "adb-devices",
          selection.binary,
          ["devices", "-l"],
          {
            timeoutMs: DEVICES_TIMEOUT_MS,
            maxOutputBytes: DEVICES_MAX_OUTPUT_BYTES,
          },
          signal,
        );
        if (!ran.ok) return ran;
        const { devices, unparsedLines, daemonStarted } = parseAdbDevicesOutput(
          ran.value.stdout,
        );
        if (unparsedLines.length > 0)
          return err(
            new AnalysisProtocolError(
              `adb devices reported an unrecognized line: ${unparsedLines[0]}`,
            ),
          );
        return ok(
          createAnalysisExecution(
            { client, devices, may_have_started_adb_server: daemonStarted },
            provider,
            {
              limitations: [
                "Device kind is inferred from the emulator serial prefix and USB transport metadata, not from device attestation",
                "Kind stays unknown for TCP transports unless the serial is an emulator port",
              ],
            },
          ),
        );
      }
      case "inspect_adb_device": {
        const ran = await runAdb(
          operation,
          request.input.serial,
          selection.binary,
          adbArguments(request.input.serial, ["shell", "getprop"]),
          {
            timeoutMs: SHELL_TIMEOUT_MS,
            maxOutputBytes: GETPROP_MAX_OUTPUT_BYTES,
          },
          signal,
        );
        if (!ran.ok) return ran;
        const { properties, emulatorObserved } = parseGetpropOutput(
          ran.value.stdout,
        );
        return ok(
          createAnalysisExecution(
            {
              client,
              serial: request.input.serial,
              properties,
              property_count: properties.length,
              emulator_observed: emulatorObserved,
            },
            provider,
            {
              limitations: [
                "Properties are a fixed whitelist of build identity facts, not the full getprop dump",
                "emulator_observed is null when the build does not report ro.kernel.qemu",
              ],
            },
          ),
        );
      }
      case "list_adb_packages": {
        const scopeFlag =
          request.input.scope === "third_party"
            ? "-3"
            : request.input.scope === "system"
              ? "-s"
              : null;
        const ran = await shell(
          [
            "pm",
            "list",
            "packages",
            "-f",
            ...(scopeFlag === null ? [] : [scopeFlag]),
          ],
          {
            timeoutMs: PACKAGE_LIST_TIMEOUT_MS,
            maxOutputBytes: PACKAGE_LIST_MAX_OUTPUT_BYTES,
          },
        );
        if (!ran.ok) return ran;
        const { packages, unparsedLines } = parsePackageListOutput(
          ran.value.stdout,
        );
        return ok(
          createAnalysisExecution(
            {
              client,
              serial: request.input.serial,
              scope: request.input.scope,
              packages,
              ...reported(unparsedLines, "complete"),
            },
            provider,
            {
              limitations: [
                "base_apk_device_path is a device filesystem path, not a host-local path",
                ...unparsedOverflowLimitation(unparsedLines),
              ],
            },
          ),
        );
      }
      case "pull_adb_package":
        return this.pullPackage(
          operation,
          selection,
          client,
          provider,
          request.input,
          signal,
        );
      case "read_adb_logcat": {
        const ran = await shell(
          [
            "logcat",
            "-d",
            "-b",
            request.input.buffer,
            "-t",
            String(request.input.count),
            ...(request.input.pid === undefined
              ? []
              : ["--pid", String(request.input.pid)]),
          ],
          {
            timeoutMs: LOGCAT_TIMEOUT_MS,
            maxOutputBytes: LOGCAT_MAX_OUTPUT_BYTES,
          },
        );
        if (!ran.ok) return ran;
        const lines = ran.value.stdout.split(/\r?\n/u);
        if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
        const bounded = lines.slice(-request.input.count);
        return ok(
          createAnalysisExecution(
            {
              client,
              serial: request.input.serial,
              count: request.input.count,
              buffer: request.input.buffer,
              pid: request.input.pid ?? null,
              lines: bounded,
              total_bytes: ran.value.stdout.length,
              coverage:
                bounded.length !== lines.length ||
                bounded.length === request.input.count
                  ? "partial"
                  : "complete",
            },
            provider,
            {
              limitations: [
                "Reads a bounded dump (logcat -d); the newest lines are kept when the count cap trims",
                "coverage is partial when the requested count or capture budget truncated the dump",
              ],
            },
          ),
        );
      }
      case "inspect_adb_package": {
        const ran = await shell(["dumpsys", "package", request.input.package], {
          timeoutMs: DUMPSYS_PACKAGE_TIMEOUT_MS,
          maxOutputBytes: DUMPSYS_PACKAGE_MAX_OUTPUT_BYTES,
        });
        if (!ran.ok) return ran;
        const stdout = ran.value.stdout;
        if (/Unable to find package:/u.test(stdout) || stdout.trim() === "")
          return err(
            new AnalysisUnsupportedTargetError(
              operation,
              request.input.serial,
              `Package Manager did not report details for ${request.input.package}; it may not be installed for user 0`,
            ),
          );
        const details = parseDumpsysPackageOutput(stdout);
        return ok(
          createAnalysisExecution(
            {
              client,
              serial: request.input.serial,
              package_name: request.input.package,
              version_name: details.versionName,
              version_code: details.versionCode,
              first_install_time: details.firstInstallTime,
              last_update_time: details.lastUpdateTime,
              installer_package_name: details.installerPackageName,
              user_id: details.userId,
              pkg_flags: details.pkgFlags,
              requested_permissions_count: details.requestedPermissions,
              coverage:
                details.versionCode === null && details.versionName === null
                  ? "partial"
                  : "complete",
            },
            provider,
            {
              limitations: [
                "Fields are a fixed projection of dumpsys package output; version-dependent sections are ignored rather than guessed",
                "requested_permissions_count counts the listed requested permissions section only",
              ],
            },
          ),
        );
      }
      case "pull_adb_file":
        return this.pullFile(
          operation,
          selection,
          client,
          provider,
          request.input,
          signal,
        );
      case "push_adb_file":
        return this.pushFile(
          operation,
          selection,
          client,
          provider,
          request.input,
          signal,
        );
      case "capture_adb_screen":
        return this.captureScreen(
          operation,
          selection,
          client,
          provider,
          request.input,
          signal,
        );
      case "collect_adb_bugreport":
        return this.collectBugreport(
          operation,
          selection,
          client,
          provider,
          request.input,
          signal,
        );
      case "list_adb_processes": {
        const ran = await shell(["ps", "-A"], {
          timeoutMs: LISTING_TIMEOUT_MS,
          maxOutputBytes: LISTING_MAX_OUTPUT_BYTES,
        });
        if (!ran.ok) return ran;
        const { columns, processes, unparsedLines } = parseProcessListOutput(
          ran.value.stdout,
        );
        return ok(
          createAnalysisExecution(
            {
              client,
              serial: request.input.serial,
              columns,
              processes,
              ...reported(unparsedLines, "complete"),
            },
            provider,
            { limitations: unparsedOverflowLimitation(unparsedLines) },
          ),
        );
      }
      case "list_adb_directory": {
        const ran = await shell(["ls", "-la", request.input.device_path], {
          timeoutMs: LISTING_TIMEOUT_MS,
          maxOutputBytes: LISTING_MAX_OUTPUT_BYTES,
        });
        if (!ran.ok) return ran;
        const { entries, unparsedLines } = parseLsOutput(ran.value.stdout);
        return ok(
          createAnalysisExecution(
            {
              client,
              serial: request.input.serial,
              device_path: request.input.device_path,
              entries,
              ...reported(unparsedLines, "complete"),
            },
            provider,
            {
              limitations: [
                "Entry kinds derive from the permission string's type character",
                ...unparsedOverflowLimitation(unparsedLines),
              ],
            },
          ),
        );
      }
      case "list_adb_features": {
        const ran = await shell(["pm", "list", "features"], {
          timeoutMs: LISTING_TIMEOUT_MS,
          maxOutputBytes: LISTING_MAX_OUTPUT_BYTES,
        });
        if (!ran.ok) return ran;
        const { features, unparsedLines } = parseFeatureListOutput(
          ran.value.stdout,
        );
        return ok(
          createAnalysisExecution(
            {
              client,
              serial: request.input.serial,
              features,
              ...reported(unparsedLines, "complete"),
            },
            provider,
            { limitations: unparsedOverflowLimitation(unparsedLines) },
          ),
        );
      }
      case "list_adb_services": {
        const ran = await shell(["service", "list"], {
          timeoutMs: LISTING_TIMEOUT_MS,
          maxOutputBytes: LISTING_MAX_OUTPUT_BYTES,
        });
        if (!ran.ok) return ran;
        const { services, unparsedLines } = parseServiceListOutput(
          ran.value.stdout,
        );
        return ok(
          createAnalysisExecution(
            {
              client,
              serial: request.input.serial,
              services,
              ...reported(unparsedLines, "complete"),
            },
            provider,
            { limitations: unparsedOverflowLimitation(unparsedLines) },
          ),
        );
      }
      case "inspect_adb_display": {
        const size = await shell(["wm", "size"], {
          timeoutMs: SETTINGS_TIMEOUT_MS,
          maxOutputBytes: SETTINGS_MAX_OUTPUT_BYTES,
        });
        if (!size.ok) return size;
        const density = await shell(["wm", "density"], {
          timeoutMs: SETTINGS_TIMEOUT_MS,
          maxOutputBytes: SETTINGS_MAX_OUTPUT_BYTES,
        });
        if (!density.ok) return density;
        const parsedSize = parseWmSizeOutput(size.value.stdout);
        if (parsedSize.physical === null)
          return err(
            new AnalysisProtocolError(
              "wm size did not report a physical size; the build may use an unsupported format",
            ),
          );
        const parsedDensity = parseWmDensityOutput(density.value.stdout);
        return ok(
          createAnalysisExecution(
            {
              client,
              serial: request.input.serial,
              physical_size: parsedSize.physical,
              override_size: parsedSize.override,
              physical_density: parsedDensity.physical,
              override_density: parsedDensity.override,
            },
            provider,
            {
              limitations: [
                "Override values are present only when a build has overridden the physical values",
              ],
            },
          ),
        );
      }
      case "inspect_adb_window": {
        const ran = await shell(["dumpsys", "window", "windows"], {
          timeoutMs: SHELL_TIMEOUT_MS,
          maxOutputBytes: DUMPSYS_WINDOW_MAX_OUTPUT_BYTES,
        });
        if (!ran.ok) return ran;
        const { focusedWindow, focusedApp } = parseWindowFocusOutput(
          ran.value.stdout,
        );
        return ok(
          createAnalysisExecution(
            {
              client,
              serial: request.input.serial,
              focused_window: focusedWindow,
              focused_app: focusedApp,
              observed_lines: [
                ...(focusedWindow === null ? [] : [focusedWindow]),
                ...(focusedApp === null ? [] : [focusedApp]),
              ],
            },
            provider,
            {
              limitations: [
                "Focus values are the window manager's declarations at read time; no interaction occurred",
              ],
            },
          ),
        );
      }
      case "read_adb_setting": {
        const ran = await shell(
          ["settings", "get", request.input.namespace, request.input.key],
          {
            timeoutMs: SETTINGS_TIMEOUT_MS,
            maxOutputBytes: SETTINGS_MAX_OUTPUT_BYTES,
          },
        );
        if (!ran.ok) return ran;
        const { value, deviceReportedNull } = parseSettingsGetOutput(
          ran.value.stdout,
        );
        return ok(
          createAnalysisExecution(
            {
              client,
              serial: request.input.serial,
              namespace: request.input.namespace,
              key: request.input.key,
              value,
              device_reported_null: deviceReportedNull,
            },
            provider,
            {
              limitations: [
                "Android prints the literal string null for absent keys; that is reported as a device-side null observation",
              ],
            },
          ),
        );
      }
      case "resolve_adb_packages": {
        const ran = await shell(["pm", "list", "packages", "-f"], {
          timeoutMs: PACKAGE_LIST_TIMEOUT_MS,
          maxOutputBytes: PACKAGE_LIST_MAX_OUTPUT_BYTES,
        });
        if (!ran.ok) return ran;
        const { packages, unparsedLines } = parsePackageListOutput(
          ran.value.stdout,
        );
        const needle = request.input.query.toLowerCase();
        const matches = packages.filter((entry) =>
          entry.package_name.toLowerCase().includes(needle),
        );
        return ok(
          createAnalysisExecution(
            {
              client,
              serial: request.input.serial,
              query: request.input.query,
              matches,
              exact_match:
                matches.length === 1 &&
                matches[0]!.package_name.toLowerCase() === needle,
              coverage: unparsedLines.length > 0 ? "partial" : "complete",
            },
            provider,
            {
              limitations: [
                "Matching is a case-insensitive substring over package names; application display labels are not part of pm output",
                ...unparsedOverflowLimitation(unparsedLines),
              ],
            },
          ),
        );
      }
      case "install_adb_package":
        return this.installPackage(
          operation,
          selection,
          client,
          provider,
          request.input,
          signal,
        );
      case "uninstall_adb_package":
        return this.uninstallPackage(
          operation,
          selection,
          client,
          provider,
          request.input,
          signal,
        );
      case "start_adb_app":
        return this.startApp(
          operation,
          selection,
          client,
          provider,
          request.input,
          signal,
        );
      case "start_adb_activity":
        return this.startActivity(
          operation,
          selection,
          client,
          provider,
          request.input,
          signal,
        );
      case "stop_adb_app":
        return this.stopApp(
          operation,
          selection,
          client,
          provider,
          request.input,
          signal,
        );
    }
  }

  private async pullPackage(
    operation: "pull_adb_package",
    selection: AdbBinarySelection,
    client: ClientIdentity,
    provider: ProviderIdentity,
    input: {
      readonly serial: string;
      readonly package: string;
      readonly output_directory: string;
    },
    signal: AbortSignal | undefined,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    const { serial, package: packageName } = input;
    const paths = await runAdb(
      operation,
      serial,
      selection.binary,
      adbArguments(serial, ["shell", "pm", "path", packageName]),
      {
        timeoutMs: PM_PATH_TIMEOUT_MS,
        maxOutputBytes: PM_PATH_MAX_OUTPUT_BYTES,
      },
      signal,
    );
    if (!paths.ok) return paths;
    const parsed = parsePmPathOutput(paths.value.stdout);
    if (parsed.paths.length === 0 && parsed.unparsedLines.length === 0)
      return err(
        new AnalysisUnsupportedTargetError(
          operation,
          serial,
          `Package Manager reported no APK paths for ${packageName}; it may not be installed for user 0`,
        ),
      );
    if (parsed.unparsedLines.length > 0)
      return err(
        new AnalysisProtocolError(
          `pm path reported an unrecognized line: ${parsed.unparsedLines[0]}`,
        ),
      );
    const directory = await prepareOutputDirectory(
      operation,
      input.output_directory,
    );
    if (!directory.ok) return directory;
    const packageDirectory = join(directory.value, packageName);
    try {
      if (
        await stat(packageDirectory).then(
          () => true,
          () => false,
        )
      )
        throw new Error(
          `The package output directory already exists: ${packageDirectory}`,
        );
      await mkdir(packageDirectory);
    } catch (cause) {
      return err(
        new AnalysisOutputError(
          operation,
          cause instanceof Error ? cause.message : String(cause),
          { cause },
        ),
      );
    }
    const artifacts: {
      device_path: string;
      file_name: string;
      local_path: string;
      bytes: number;
      sha256: string;
      role: "base" | "split" | "unknown";
      role_basis: "file_name";
    }[] = [];
    const failures: {
      device_path: string | null;
      stage: "resolve_paths" | "pull" | "digest";
      message: string;
    }[] = [];
    const seenFileNames = new Set<string>();
    for (const entry of parsed.paths) {
      if (seenFileNames.has(entry.file_name)) {
        failures.push({
          device_path: entry.device_path,
          stage: "pull",
          message: `Duplicate file name ${entry.file_name} in the APK set; refusing to overwrite`,
        });
        continue;
      }
      seenFileNames.add(entry.file_name);
      const localPath = join(packageDirectory, entry.file_name);
      const pulled = await runAdb(
        operation,
        serial,
        selection.binary,
        adbArguments(serial, ["pull", entry.device_path, localPath]),
        { timeoutMs: PULL_TIMEOUT_MS, maxOutputBytes: PULL_MAX_OUTPUT_BYTES },
        signal,
      );
      if (!pulled.ok) {
        if (pulled.error instanceof AnalysisCancelledError) return pulled;
        failures.push({
          device_path: entry.device_path,
          stage: "pull",
          message: pulled.error.message,
        });
        continue;
      }
      try {
        const info = await stat(localPath);
        const sha256 = await sha256File(localPath);
        artifacts.push({
          device_path: entry.device_path,
          file_name: entry.file_name,
          local_path: localPath,
          bytes: info.size,
          sha256,
          role: entry.role,
          role_basis: "file_name",
        });
      } catch {
        failures.push({
          device_path: entry.device_path,
          stage: "digest",
          message: `The pulled file could not be read back after pulling: ${localPath}`,
        });
      }
    }
    if (artifacts.length === 0 && failures.length > 0) {
      await rm(packageDirectory, { recursive: true, force: true }).catch(
        () => undefined,
      );
      return err(
        new AnalysisProtocolError(
          `Every APK pull failed for ${packageName} on ${serial}: ${failures[0]!.message}`,
        ),
      );
    }
    return ok(
      createAnalysisExecution(
        {
          client,
          serial,
          package_name: packageName,
          output_directory: directory.value,
          artifacts,
          failures,
          coverage: failures.length === 0 ? "complete" : "partial",
        },
        provider,
        {
          limitations: [
            "APK role names derive from the pulled file names (base.apk, split_*.apk)",
            "Pulled artifacts are host-local copies; the device retains the originals",
          ],
        },
      ),
    );
  }

  private async pullFile(
    operation: "pull_adb_file",
    selection: AdbBinarySelection,
    client: ClientIdentity,
    provider: ProviderIdentity,
    input: {
      readonly serial: string;
      readonly device_path: string;
      readonly output_directory: string;
    },
    signal: AbortSignal | undefined,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    const directory = await prepareOutputDirectory(
      operation,
      input.output_directory,
    );
    if (!directory.ok) return directory;
    const fileName = basename(input.device_path) || "pulled";
    const localPath = join(directory.value, fileName);
    const existing = await refuseExistingTarget(operation, localPath);
    if (existing !== undefined) return err(existing);
    const pulled = await runAdb(
      operation,
      input.serial,
      selection.binary,
      adbArguments(input.serial, ["pull", input.device_path, localPath]),
      { timeoutMs: PULL_TIMEOUT_MS, maxOutputBytes: PULL_MAX_OUTPUT_BYTES },
      signal,
    );
    if (!pulled.ok) return pulled;
    try {
      const info = await stat(localPath);
      const sha256 = await sha256File(localPath);
      return ok(
        createAnalysisExecution(
          {
            client,
            serial: input.serial,
            device_path: input.device_path,
            local_path: localPath,
            bytes: info.size,
            sha256,
          },
          provider,
          {
            limitations: [
              "The pulled file is a host-local copy; the device retains the original",
            ],
          },
        ),
      );
    } catch (cause) {
      return err(
        new AnalysisOutputError(
          operation,
          `The pulled file could not be read back after pulling: ${localPath}`,
          { cause },
        ),
      );
    }
  }

  private async pushFile(
    operation: "push_adb_file",
    selection: AdbBinarySelection,
    client: ClientIdentity,
    provider: ProviderIdentity,
    input: {
      readonly serial: string;
      readonly local_path: string;
      readonly device_path: string;
      readonly overwrite: boolean;
    },
    signal: AbortSignal | undefined,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    const localPath = resolve(input.local_path);
    const info = await stat(localPath).then(
      (value) => value,
      () => null,
    );
    if (info === null || !info.isFile())
      return err(
        new AnalysisInputError(operation, {
          cause: new Error(`The local file does not exist: ${localPath}`),
        }),
      );
    const sha256 = await sha256File(localPath);
    const existsProbe = await runAdb(
      operation,
      input.device_path,
      selection.binary,
      adbArguments(input.serial, ["shell", "test", "-e", input.device_path]),
      { timeoutMs: SETTINGS_TIMEOUT_MS, maxOutputBytes: 1024 },
      signal,
    );
    let deviceExists: boolean;
    if (existsProbe.ok) deviceExists = true;
    else if (existsProbe.error instanceof AnalysisProtocolError)
      deviceExists = false;
    else if (existsProbe.error instanceof AnalysisTimeoutError)
      return existsProbe;
    else if (existsProbe.error instanceof AnalysisCancelledError)
      return existsProbe;
    else if (existsProbe.error instanceof AnalysisResourceConstraintError)
      return existsProbe;
    else deviceExists = true; // authorization/refusal states surface on push instead
    if (deviceExists && !input.overwrite)
      return err(
        new AnalysisOutputError(
          operation,
          `The device path already exists and overwrite was not requested: ${input.device_path}`,
        ),
      );
    const pushed = await runAdb(
      operation,
      input.device_path,
      selection.binary,
      adbArguments(input.serial, ["push", localPath, input.device_path]),
      { timeoutMs: PULL_TIMEOUT_MS, maxOutputBytes: PULL_MAX_OUTPUT_BYTES },
      signal,
    );
    if (!pushed.ok) return pushed;
    const deviceDigest = await runAdb(
      operation,
      input.device_path,
      selection.binary,
      adbArguments(input.serial, ["shell", "sha256sum", input.device_path]),
      { timeoutMs: SHELL_TIMEOUT_MS, maxOutputBytes: 1024 },
      signal,
    );
    if (deviceDigest.ok) {
      const digestMatch = /^([a-f0-9]{64})\s/u.exec(deviceDigest.value.stdout);
      if (digestMatch !== null && digestMatch[1] !== sha256)
        return err(
          new AnalysisArtifactChangedError(
            operation,
            input.device_path,
            `The device-reported digest does not match the pushed local file: ${localPath}`,
          ),
        );
      return ok(
        createAnalysisExecution(
          {
            client,
            serial: input.serial,
            local_path: localPath,
            device_path: input.device_path,
            bytes: info.size,
            sha256,
            device_sha256: digestMatch?.[1] ?? null,
            overwritten: deviceExists,
            device_digest_source: "device_sha256sum",
          },
          provider,
          {
            limitations: [
              "Push writes the caller's file to the device; this is the only device-mutating ADB tool",
            ],
          },
        ),
      );
    }
    return ok(
      createAnalysisExecution(
        {
          client,
          serial: input.serial,
          local_path: localPath,
          device_path: input.device_path,
          bytes: info.size,
          sha256,
          device_sha256: null,
          overwritten: deviceExists,
          device_digest_source: "unavailable",
        },
        provider,
        {
          limitations: [
            "The device did not answer sha256sum, so the transfer is not device-side verified",
            "Push writes the caller's file to the device; this is the only device-mutating ADB tool",
          ],
        },
      ),
    );
  }

  private async installPackage(
    operation: "install_adb_package",
    selection: AdbBinarySelection,
    client: ClientIdentity,
    provider: ProviderIdentity,
    input: {
      readonly serial: string;
      readonly apk_path: string;
      readonly replace: boolean;
    },
    signal: AbortSignal | undefined,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    const apkPath = resolve(input.apk_path);
    const info = await stat(apkPath).then(
      (value) => value,
      () => null,
    );
    if (info === null || !info.isFile())
      return err(
        new AnalysisInputError(operation, {
          cause: new Error(`The local APK does not exist: ${apkPath}`),
        }),
      );
    const sha256 = await sha256File(apkPath);
    const installed = await runAdb(
      operation,
      input.serial,
      selection.binary,
      adbArguments(input.serial, [
        "install",
        ...(input.replace ? ["-r"] : []),
        apkPath,
      ]),
      { timeoutMs: PULL_TIMEOUT_MS, maxOutputBytes: PULL_MAX_OUTPUT_BYTES },
      signal,
    );
    if (!installed.ok) return installed;
    const verdict = parsePackageChangeOutput(installed.value.stdout);
    if (verdict.status === "failure")
      return err(
        new AnalysisUnsupportedTargetError(
          operation,
          input.serial,
          verdict.reason ?? "the device refused the installation",
        ),
      );
    return ok(
      createAnalysisExecution(
        {
          client,
          serial: input.serial,
          apk_path: apkPath,
          bytes: info.size,
          sha256,
          replaced: input.replace,
        },
        provider,
        {
          limitations: [
            "Install changes device state; the installed APK's digest is the host file's digest",
          ],
        },
      ),
    );
  }

  private async uninstallPackage(
    operation: "uninstall_adb_package",
    selection: AdbBinarySelection,
    client: ClientIdentity,
    provider: ProviderIdentity,
    input: { readonly serial: string; readonly package: string },
    signal: AbortSignal | undefined,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    const uninstalled = await runAdb(
      operation,
      input.serial,
      selection.binary,
      adbArguments(input.serial, ["uninstall", input.package]),
      {
        timeoutMs: PACKAGE_LIST_TIMEOUT_MS,
        maxOutputBytes: PULL_MAX_OUTPUT_BYTES,
      },
      signal,
    );
    if (!uninstalled.ok) return uninstalled;
    const verdict = parsePackageChangeOutput(uninstalled.value.stdout);
    if (verdict.status === "failure")
      return err(
        new AnalysisUnsupportedTargetError(
          operation,
          input.serial,
          verdict.reason ?? "the device refused the removal",
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
            "Uninstall removes the package and its data for user 0; keeping data (-k) is not exposed",
          ],
        },
      ),
    );
  }

  private async startApp(
    operation: "start_adb_app",
    selection: AdbBinarySelection,
    client: ClientIdentity,
    provider: ProviderIdentity,
    input: { readonly serial: string; readonly package: string },
    signal: AbortSignal | undefined,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    const resolved = await runAdb(
      operation,
      input.serial,
      selection.binary,
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
      { timeoutMs: SHELL_TIMEOUT_MS, maxOutputBytes: PM_PATH_MAX_OUTPUT_BYTES },
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
    return this.runAmStart(
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
  }

  private async startActivity(
    operation: "start_adb_activity",
    selection: AdbBinarySelection,
    client: ClientIdentity,
    provider: ProviderIdentity,
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
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
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
    for (const extra of input.extras)
      if (extra.type === "boolean" && !/^(true|false)$/u.test(extra.value))
        return err(
          new AnalysisInputError(operation, {
            cause: new Error(
              `Boolean extra ${extra.key} must be true or false`,
            ),
          }),
        );
      else if (
        (extra.type === "int" || extra.type === "long") &&
        !/^-?\d+$/u.test(extra.value)
      )
        return err(
          new AnalysisInputError(operation, {
            cause: new Error(
              `${extra.type === "int" ? "Integer" : "Long"} extra ${extra.key} must be an integer`,
            ),
          }),
        );
      else if (extra.type === "float" && !/^-?\d+(\.\d+)?$/u.test(extra.value))
        return err(
          new AnalysisInputError(operation, {
            cause: new Error(`Float extra ${extra.key} must be a number`),
          }),
        );
    const arguments_ = [
      "-a",
      input.action,
      ...(input.data_uri === undefined ? [] : ["-d", input.data_uri]),
      ...(input.component === undefined ? [] : ["-n", input.component]),
      ...input.extras.flatMap((extra) => [
        extraFlags[extra.type],
        extra.key,
        extra.value,
      ]),
    ];
    return this.runAmStart(
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
  }

  private async runAmStart(
    operation: "start_adb_app" | "start_adb_activity",
    selection: AdbBinarySelection,
    client: ClientIdentity,
    provider: ProviderIdentity,
    serial: string,
    arguments_: readonly string[],
    resultFields: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    const started = await runAdb(
      operation,
      serial,
      selection.binary,
      adbArguments(serial, ["shell", "am", "start", "-W", ...arguments_]),
      { timeoutMs: SHELL_TIMEOUT_MS, maxOutputBytes: PM_PATH_MAX_OUTPUT_BYTES },
      signal,
    );
    if (!started.ok) return started;
    const verdict = parseAmStartOutput(started.value.stdout);
    if (verdict.status === "refused")
      return err(
        new AnalysisUnsupportedTargetError(
          operation,
          serial,
          verdict.reason ?? "am start refused the intent",
        ),
      );
    return ok(
      createAnalysisExecution(
        {
          ...resultFields,
          started_activity: verdict.startedActivity,
        },
        provider,
        {
          limitations: [
            "Starting an activity changes device state; am start -W waits for launch completion but no lifecycle observation is captured",
          ],
        },
      ) as AnalysisExecution,
    );
  }

  private async stopApp(
    operation: "stop_adb_app",
    selection: AdbBinarySelection,
    client: ClientIdentity,
    provider: ProviderIdentity,
    input: { readonly serial: string; readonly package: string },
    signal: AbortSignal | undefined,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    const stopped = await runAdb(
      operation,
      input.serial,
      selection.binary,
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
  }

  private async captureScreen(
    operation: "capture_adb_screen",
    selection: AdbBinarySelection,
    client: ClientIdentity,
    provider: ProviderIdentity,
    input: { readonly serial: string; readonly output_directory: string },
    signal: AbortSignal | undefined,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    const directory = await prepareOutputDirectory(
      operation,
      input.output_directory,
    );
    if (!directory.ok) return directory;
    const localPath = join(directory.value, "screen.png");
    const existing = await refuseExistingTarget(operation, localPath);
    if (existing !== undefined) return err(existing);
    const captured = await runAdbBinary(
      operation,
      selection.binary,
      adbArguments(input.serial, ["exec-out", "screencap", "-p"]),
      { timeoutMs: SCREEN_TIMEOUT_MS, maxOutputBytes: SCREEN_MAX_OUTPUT_BYTES },
      signal,
    );
    if (!captured.ok) return captured;
    const dimensions = parsePngDimensions(captured.value);
    if (dimensions.width === null)
      return err(
        new AnalysisProtocolError(
          "screencap did not return a PNG payload; the device may not expose a display",
        ),
      );
    try {
      await writeFile(localPath, captured.value, { flag: "wx" });
    } catch (cause) {
      return err(
        new AnalysisOutputError(
          operation,
          `The screen output could not be created exclusively: ${localPath}`,
          { cause },
        ),
      );
    }
    const sha256 = createHash("sha256").update(captured.value).digest("hex");
    return ok(
      createAnalysisExecution(
        {
          client,
          serial: input.serial,
          local_path: localPath,
          bytes: captured.value.byteLength,
          sha256,
          width: dimensions.width,
          height: dimensions.height,
        },
        provider,
        {
          limitations: [
            "The capture is one frame at read time; no recording or interaction occurred",
          ],
        },
      ),
    );
  }

  private async collectBugreport(
    operation: "collect_adb_bugreport",
    selection: AdbBinarySelection,
    client: ClientIdentity,
    provider: ProviderIdentity,
    input: { readonly serial: string; readonly output_directory: string },
    signal: AbortSignal | undefined,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    const directory = await prepareOutputDirectory(
      operation,
      input.output_directory,
    );
    if (!directory.ok) return directory;
    const collected = await runAdb(
      operation,
      input.serial,
      selection.binary,
      adbArguments(input.serial, ["bugreport", directory.value]),
      {
        timeoutMs: BUGREPORT_TIMEOUT_MS,
        maxOutputBytes: BUGREPORT_MAX_OUTPUT_BYTES,
      },
      signal,
    );
    if (!collected.ok) return collected;
    const reportedPath = parseBugreportCopiedPath(collected.value.stdout);
    if (reportedPath === null)
      return err(
        new AnalysisProtocolError(
          "adb bugreport did not report an archive path; the build may use an unsupported format",
        ),
      );
    try {
      const info = await stat(reportedPath);
      const sha256 = await sha256File(reportedPath);
      return ok(
        createAnalysisExecution(
          {
            client,
            serial: input.serial,
            local_path: reportedPath,
            bytes: info.size,
            sha256,
            adb_reported_path: reportedPath,
          },
          provider,
          {
            limitations: [
              "The archive is device-generated: dumpstate, dumpsys, and logcat content is the device's own report",
            ],
          },
        ),
      );
    } catch (cause) {
      return err(
        new AnalysisOutputError(
          operation,
          `The reported bugreport archive could not be read back: ${reportedPath}`,
          { cause },
        ),
      );
    }
  }
}
