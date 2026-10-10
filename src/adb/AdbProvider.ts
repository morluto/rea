import { createHash } from "node:crypto";
import { createReadStream, constants as fsConstants } from "node:fs";
import { access, mkdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

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
  AnalysisCapabilityUnavailableError,
  AnalysisCancelledError,
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
const STDERR_EXCERPT_BYTES = 512;
const UNPARSED_LINES_REPORTED = 10;

/** Stream a local file digest without retaining large APKs in memory. */
const sha256File = async (path: string): Promise<string> => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
};

/** Fixed adb argument vectors; caller values never reach a shell. */
const adbArguments = (
  serial: string | undefined,
  arguments_: readonly string[],
): readonly string[] =>
  serial === undefined ? [...arguments_] : ["-s", serial, ...arguments_];

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
  // Captured before the call: an abort during execution settles the promise
  // through this reason rather than a re-read that narrowing cannot see.
  const abortReason = signal?.reason;
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
    if (abortReason !== undefined)
      return err(new AnalysisCancelledError(operation, { cause: abortReason }));
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
        new AnalysisUnsupportedTargetError(
          operation,
          targetPath,
          excerpt || "adb reported the device unauthorized",
          { cause },
        ),
      );
    if (
      /device[^\n]*not found|device offline|still authorizing|more than one device/iu.test(
        excerpt,
      )
    )
      return err(
        new AnalysisUnsupportedTargetError(
          operation,
          targetPath,
          excerpt || "adb reported no usable device",
          { cause },
        ),
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

const clientIdentityResult = (
  selection: AdbBinarySelection,
  identity: AdbClientIdentity,
) => ({
  binary_path: selection.binary,
  path_source: selection.pathSource,
  version: identity.version,
  installed_path: identity.installedPath,
});

export interface AdbProviderOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

/**
 * ADB device inspection and acquisition over a caller-selected adb binary.
 *
 * Every operation composes fixed adb argument vectors: caller values occupy
 * positional arguments only and never reach a shell. The provider never
 * starts an emulator, installs platform tools, or mutates the device; the
 * only filesystem writes are the caller-requested APK pulls, materialized in
 * a package-named directory that must not already exist.
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
    const provider = {
      ...ADB_PROVIDER_IDENTITY,
      version: identity.version,
    };
    switch (request.operation) {
      case "inspect_adb_client":
        return ok(
          createAnalysisExecution(
            { client, contacted_adb_server: false },
            provider,
          ),
        );
      case "list_adb_devices":
        return this.listDevices(
          request.operation,
          selection,
          client,
          provider,
          signal,
        );
      case "inspect_adb_device":
        return this.inspectDevice(request, selection, client, provider, signal);
      case "list_adb_packages":
        return this.listPackages(request, selection, client, provider, signal);
      case "pull_adb_package":
        return this.pullPackage(request, selection, client, provider, signal);
    }
  }

  private async listDevices(
    operation: "list_adb_devices",
    selection: AdbBinarySelection,
    client: ReturnType<typeof clientIdentityResult>,
    provider: { id: string; name: string; version: string | null },
    signal: AbortSignal | undefined,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
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

  private async inspectDevice(
    request: { operation: "inspect_adb_device"; input: { serial: string } },
    selection: AdbBinarySelection,
    client: ReturnType<typeof clientIdentityResult>,
    provider: { id: string; name: string; version: string | null },
    signal: AbortSignal | undefined,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    const ran = await runAdb(
      request.operation,
      request.input.serial,
      selection.binary,
      adbArguments(request.input.serial, ["shell", "getprop"]),
      { timeoutMs: SHELL_TIMEOUT_MS, maxOutputBytes: GETPROP_MAX_OUTPUT_BYTES },
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

  private async listPackages(
    request: {
      operation: "list_adb_packages";
      input: { serial: string; scope: "all" | "third_party" | "system" };
    },
    selection: AdbBinarySelection,
    client: ReturnType<typeof clientIdentityResult>,
    provider: { id: string; name: string; version: string | null },
    signal: AbortSignal | undefined,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    const scopeFlag =
      request.input.scope === "third_party"
        ? "-3"
        : request.input.scope === "system"
          ? "-s"
          : null;
    const ran = await runAdb(
      request.operation,
      request.input.serial,
      selection.binary,
      adbArguments(request.input.serial, [
        "shell",
        "pm",
        "list",
        "packages",
        "-f",
        ...(scopeFlag === null ? [] : [scopeFlag]),
      ]),
      {
        timeoutMs: PACKAGE_LIST_TIMEOUT_MS,
        maxOutputBytes: PACKAGE_LIST_MAX_OUTPUT_BYTES,
      },
      signal,
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
          unparsed_lines: unparsedLines.slice(0, UNPARSED_LINES_REPORTED),
          coverage: unparsedLines.length > 0 ? "partial" : "complete",
        },
        provider,
        {
          limitations: [
            "base_apk_device_path is a device filesystem path, not a host-local path",
            ...(unparsedLines.length > UNPARSED_LINES_REPORTED
              ? [
                  `unparsed_lines reports the first ${String(UNPARSED_LINES_REPORTED)} of ${String(unparsedLines.length)} unrecognized lines`,
                ]
              : []),
          ],
        },
      ),
    );
  }

  private async pullPackage(
    request: {
      operation: "pull_adb_package";
      input: {
        serial: string;
        package: string;
        output_directory: string;
      };
    },
    selection: AdbBinarySelection,
    client: ReturnType<typeof clientIdentityResult>,
    provider: { id: string; name: string; version: string | null },
    signal: AbortSignal | undefined,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    const { serial, package: packageName } = request.input;
    const paths = await runAdb(
      request.operation,
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
          request.operation,
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
    const outputRoot = resolve(request.input.output_directory);
    try {
      await mkdir(outputRoot, { recursive: true });
      await access(outputRoot, fsConstants.W_OK);
    } catch (cause) {
      return err(
        new AnalysisOutputError(
          request.operation,
          `The output directory is not writable or could not be created: ${outputRoot}`,
          { cause },
        ),
      );
    }
    const packageDirectory = join(outputRoot, packageName);
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
          request.operation,
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
        request.operation,
        serial,
        selection.binary,
        adbArguments(serial, ["pull", entry.device_path, localPath]),
        { timeoutMs: PULL_TIMEOUT_MS, maxOutputBytes: PULL_MAX_OUTPUT_BYTES },
        signal,
      );
      if (!pulled.ok) {
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
          output_directory: outputRoot,
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
}
