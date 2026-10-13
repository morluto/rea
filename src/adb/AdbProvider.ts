import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access,
  copyFile,
  lstat,
  mkdtemp,
  mkdir,
  rmdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";

import type {
  ExecutionOptions,
  ProviderAvailability,
} from "../application/AnalysisProvider.js";
import { providerConfigurationRefusal } from "../domain/providerConfigurationRefusal.js";
import {
  createAnalysisExecution,
  type AnalysisExecution,
} from "../application/AnalysisProvider.js";
import type {
  AdbActivityStartPartialObservation,
  AdbAcquiredFilePartialObservation,
  AdbRequest,
} from "../domain/adb/adbDeviceAnalysis.js";
import { adbResultSchemas } from "../domain/adb/adbDeviceAnalysis.js";
import {
  AnalysisArtifactChangedError,
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
  AnalysisProtocolError,
  AnalysisResourceConstraintError,
  AnalysisTimeoutError,
  AnalysisUnsupportedTargetError,
} from "../domain/analysisErrorCore.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import { err, ok, type Result } from "../domain/result.js";
import { hashStableFile } from "../filesystem/StableFileHash.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import {
  execFileBytes,
  execFileOutputFailure,
} from "../process/ExecFileOutput.js";
import {
  AdbConfigurationFailure,
  adbConfigurationAvailability,
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
import { adbHostFileName } from "./AdbHostFileName.js";
import {
  ADB_DIRECTORY_BATCH_SCRIPT,
  parseAdbDirectoryListing,
} from "./AdbDirectoryListing.js";
import {
  parseAmStartOutput,
  parseBugreportCopiedPath,
  parseDumpsysPackageOutput,
  parseFeatureListOutput,
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

const hashAdbFile = async (
  path: string,
  operation: string,
  signal: AbortSignal | undefined,
) => {
  try {
    return await hashStableFile(path, signal);
  } catch (cause: unknown) {
    if (signal?.aborted === true)
      throw new AnalysisCancelledError(operation, { cause });
    throw cause;
  }
};

/** adb joins shell operands into a remote POSIX command; quote at that boundary. */
const quoteShellOperand = (value: string): string =>
  /^[A-Za-z0-9_./:=@+,-]+$/u.test(value)
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
const runAdbCapture = async (
  operation: string,
  targetPath: string,
  binary: string,
  arguments_: readonly string[],
  limits: AdbRunLimits,
  signal: AbortSignal | undefined,
): Promise<Result<{ stdout: Buffer; stderr: Buffer }, AnalysisError>> => {
  if (signal?.aborted === true)
    return err(new AnalysisCancelledError(operation));
  try {
    return ok(
      await execFileBytes(binary, arguments_, {
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

/** Decode textual adb protocols after the shared byte capture and error boundary. */
const runAdb = async (
  ...arguments_: Parameters<typeof runAdbCapture>
): Promise<
  Result<{ stdout: string; stderr: string; stdoutBytes: number }, AnalysisError>
> => {
  const captured = await runAdbCapture(...arguments_);
  if (!captured.ok) return captured;
  return ok({
    stdout: captured.value.stdout.toString("utf8"),
    stderr: captured.value.stderr.toString("utf8"),
    // Byte count of the captured output before UTF-8 decoding, so malformed
    // sequences replaced by U+FFFD still report their true captured size.
    stdoutBytes: captured.value.stdout.byteLength,
  });
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

/** Publish an ADB-produced archive without replacing an existing caller file. */
const publishBugreport = async (
  source: string,
  directory: string,
): Promise<string> => {
  const fileName = basename(source);
  const extension = extname(fileName);
  const stem =
    extension === "" ? fileName : fileName.slice(0, -extension.length);
  for (let suffix = 0; ; suffix += 1) {
    const destination = join(
      directory,
      suffix === 0 ? fileName : `${stem} (${String(suffix)})${extension}`,
    );
    try {
      await copyFile(source, destination, fsConstants.COPYFILE_EXCL);
      return destination;
    } catch (cause: unknown) {
      if (cause instanceof Error && "code" in cause && cause.code === "EEXIST")
        continue;
      throw cause;
    }
  }
};

export interface AdbProviderOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

interface PendingOutputDirectoryCleanup {
  readonly operation: "pull_adb_package" | "collect_adb_bugreport";
  readonly path: string;
  readonly identity: OutputDirectoryIdentity | undefined;
  readonly primary: AnalysisError;
  readonly remove: () => Promise<void>;
}

interface OutputDirectoryIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
}

const removeOwnedOutputDirectory = async (
  path: string,
  identity: OutputDirectoryIdentity | undefined,
): Promise<void> => {
  if (identity === undefined)
    throw new Error(
      `Cannot verify the created output directory identity; refusing to remove ${path}`,
    );
  let current: Awaited<ReturnType<typeof lstat>>;
  try {
    current = await lstat(path);
  } catch (cause: unknown) {
    if (cause instanceof Error && Reflect.get(cause, "code") === "ENOENT")
      return;
    throw cause;
  }
  if (
    !current.isDirectory() ||
    current.isSymbolicLink() ||
    current.dev !== identity.dev ||
    current.ino !== identity.ino ||
    current.mode !== identity.mode
  )
    throw new Error(
      `The created output directory was replaced or changed; refusing to remove ${path}`,
    );
  await rm(path, { recursive: true, force: true });
};

const reservePackageDestinations = async (
  operation: string,
  packageDirectory: string,
  entries: readonly { readonly file_name: string }[],
  capturedOutput: {
    readonly stdout: string;
    readonly stderr: string;
    readonly truncated: boolean;
  },
): Promise<AnalysisOutputError | undefined> => {
  const reservations: {
    readonly path: string;
    readonly identity: OutputDirectoryIdentity;
  }[] = [];
  for (const entry of entries) {
    const path = join(packageDirectory, entry.file_name);
    try {
      await mkdir(path);
      const created = await lstat(path);
      if (!created.isDirectory() || created.isSymbolicLink())
        throw new Error(`Could not reserve local filename ${entry.file_name}`);
      reservations.push({
        path,
        identity: {
          dev: created.dev,
          ino: created.ino,
          mode: created.mode,
        },
      });
    } catch (cause: unknown) {
      return new AnalysisOutputError(
        operation,
        `Package Manager paths cannot be written to unique local destinations at ${JSON.stringify(entry.file_name)}; refusing before pulling any files`,
        { cause, capturedOutput },
      );
    }
  }
  for (const reservation of reservations) {
    try {
      const current = await lstat(reservation.path);
      if (
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        current.dev !== reservation.identity.dev ||
        current.ino !== reservation.identity.ino ||
        current.mode !== reservation.identity.mode
      )
        throw new Error(
          `The local filename reservation changed before release: ${reservation.path}`,
        );
      await rmdir(reservation.path);
    } catch (cause: unknown) {
      return new AnalysisOutputError(
        operation,
        `Could not release a local filename reservation before pulling: ${reservation.path}`,
        { cause, capturedOutput },
      );
    }
  }
  return undefined;
};

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
  readonly #pendingOutputDirectoryCleanup =
    new Set<PendingOutputDirectoryCleanup>();
  readonly #activeOperations = new Set<Promise<void>>();
  #closing = false;
  #closePromise: Promise<void> | undefined;
  #outputCleanupPromise: Promise<void> | undefined;

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
    try {
      const selection = this.selection();
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
        return adbConfigurationAvailability(cause);
      throw cause;
    }
  }

  /** Retry removal of owned output directories retained after failed cleanup. */
  close(): Promise<void> {
    this.#closing = true;
    if (this.#closePromise !== undefined) return this.#closePromise;
    const closing = (async () => {
      await Promise.all(this.#activeOperations);
      await this.#retryOutputDirectoryCleanup();
    })().finally(() => {
      if (this.#closePromise === closing) this.#closePromise = undefined;
    });
    this.#closePromise = closing;
    return this.#closePromise;
  }

  #retryOutputDirectoryCleanup(): Promise<void> {
    if (this.#outputCleanupPromise !== undefined)
      return this.#outputCleanupPromise;
    const cleanup = this.#performOutputDirectoryCleanup().finally(() => {
      if (this.#outputCleanupPromise === cleanup)
        this.#outputCleanupPromise = undefined;
    });
    this.#outputCleanupPromise = cleanup;
    return cleanup;
  }

  async #performOutputDirectoryCleanup(): Promise<void> {
    const failures: AnalysisError[] = [];
    for (const owner of this.#pendingOutputDirectoryCleanup) {
      try {
        await owner.remove();
        this.#pendingOutputDirectoryCleanup.delete(owner);
      } catch (cause: unknown) {
        const cleanup = new ProviderCleanupError(
          ADB_PROVIDER_IDENTITY.id,
          [owner.path],
          {
            reason: cause instanceof Error ? cause.message : String(cause),
          },
          { operation: owner.operation, cause },
        );
        failures.push(
          analysisErrorWithCleanupFailure(
            owner.primary,
            cleanup,
            owner.operation,
          ),
        );
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1)
      throw new ProviderCleanupError(
        ADB_PROVIDER_IDENTITY.id,
        [...this.#pendingOutputDirectoryCleanup].map(({ path }) => path),
        {
          reason: "Failed ADB output directories remain after cleanup retry",
          operations: [...this.#pendingOutputDirectoryCleanup].map(
            ({ operation }) => operation,
          ),
          failures: failures.map(({ message, cleanupResources }) => ({
            message,
            resources: [...cleanupResources],
          })),
        },
        {
          operation: "close_binary",
          cause: new AggregateError(
            failures,
            "Multiple ADB output directory cleanups failed",
          ),
        },
      );
  }

  async execute(
    request: AdbRequest,
    options?: ExecutionOptions,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    if (this.#closing)
      return err(new AnalysisCancelledError(request.operation));
    let release!: () => void;
    const active = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#activeOperations.add(active);
    try {
      if (this.#pendingOutputDirectoryCleanup.size > 0) {
        try {
          await this.#retryOutputDirectoryCleanup();
        } catch (cause: unknown) {
          return err(
            cause instanceof AnalysisError
              ? cause
              : new ProviderCleanupError(
                  ADB_PROVIDER_IDENTITY.id,
                  [...this.#pendingOutputDirectoryCleanup].map(
                    ({ path }) => path,
                  ),
                  {
                    reason:
                      cause instanceof Error ? cause.message : String(cause),
                  },
                  { operation: request.operation, cause },
                ),
          );
        }
      }
      return await this.#executeOperation(request, options);
    } finally {
      this.#activeOperations.delete(active);
      release();
    }
  }

  async #executeOperation(
    request: AdbRequest,
    options?: ExecutionOptions,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    const signal = options?.signal;
    if (signal?.aborted === true)
      return err(new AnalysisCancelledError(request.operation));
    let selection: AdbBinarySelection;
    let identity: AdbClientIdentity;
    try {
      selection = this.selection();
      identity = await inspectAdbClient(selection, signal);
    } catch (cause) {
      if (cause instanceof AnalysisCancelledError) return err(cause);
      if (cause instanceof AdbConfigurationFailure)
        return err(
          providerConfigurationRefusal(
            ADB_PROVIDER_IDENTITY.id,
            request.operation,
            cause,
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
              total_bytes: ran.value.stdoutBytes,
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
        const ran = await runAdbCapture(
          operation,
          request.input.serial,
          selection.binary,
          adbArguments(request.input.serial, [
            "shell",
            "sh",
            "-c",
            'cd "$1" || exit\nexec find . -mindepth 1 -maxdepth 1 -exec sh -c "$2" rea-list-directory {} +',
            "rea-list-directory",
            request.input.device_path,
            ADB_DIRECTORY_BATCH_SCRIPT,
          ]),
          {
            timeoutMs: LISTING_TIMEOUT_MS,
            maxOutputBytes: LISTING_MAX_OUTPUT_BYTES,
          },
          signal,
        );
        if (!ran.ok) return ran;
        const { entries, unparsedLines } = parseAdbDirectoryListing(
          ran.value.stdout,
        );
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
                "Entry kinds derive from stat permission mode; directory contents and link targets may change during capture",
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
    const capturedOutput = {
      stdout: paths.value.stdout,
      stderr: paths.value.stderr,
      truncated: false,
    };
    if (parsed.rejectedPaths.length > 0)
      return err(
        new AnalysisOutputError(
          operation,
          `Package Manager reported paths that cannot be represented as host files: ${parsed.rejectedPaths.map((entry) => `${JSON.stringify(entry.device_path)} (${entry.reason})`).join(", ")}`,
          { capturedOutput },
        ),
      );
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
          { capturedOutput },
        ),
      );
    const destinationNames = new Set<string>();
    for (const entry of parsed.paths) {
      if (destinationNames.has(entry.file_name))
        return err(
          new AnalysisOutputError(
            operation,
            `Package Manager reported multiple paths with the same local destination ${JSON.stringify(entry.file_name)}; refusing before pulling any files`,
            { capturedOutput },
          ),
        );
      destinationNames.add(entry.file_name);
    }
    const directory = await prepareOutputDirectory(
      operation,
      input.output_directory,
    );
    if (!directory.ok) return directory;
    const packageDirectory = join(directory.value, packageName);
    let packageDirectoryCreated = false;
    let packageDirectoryIdentity: OutputDirectoryIdentity | undefined;
    try {
      if (
        await lstat(packageDirectory).then(
          () => true,
          () => false,
        )
      )
        throw new Error(
          `The package output directory already exists: ${packageDirectory}`,
        );
      await mkdir(packageDirectory);
      packageDirectoryCreated = true;
      const created = await lstat(packageDirectory);
      if (!created.isDirectory() || created.isSymbolicLink())
        throw new Error(
          `The created package output is not a regular directory: ${packageDirectory}`,
        );
      packageDirectoryIdentity = {
        dev: created.dev,
        ino: created.ino,
        mode: created.mode,
      };
    } catch (cause) {
      const primary = new AnalysisOutputError(
        operation,
        cause instanceof Error ? cause.message : String(cause),
        { cause },
      );
      if (!packageDirectoryCreated) return err(primary);
      const owner: PendingOutputDirectoryCleanup = {
        operation,
        path: packageDirectory,
        identity: packageDirectoryIdentity,
        primary,
        remove: () =>
          removeOwnedOutputDirectory(
            packageDirectory,
            packageDirectoryIdentity,
          ),
      };
      this.#pendingOutputDirectoryCleanup.add(owner);
      const cleanup = new ProviderCleanupError(
        ADB_PROVIDER_IDENTITY.id,
        [packageDirectory],
        {
          reason: "Could not establish an owned package directory identity",
        },
        { operation, cause },
      );
      return err(analysisErrorWithCleanupFailure(primary, cleanup, operation));
    }
    const failOwnedPackage = async (
      primary: AnalysisError,
    ): Promise<Result<AnalysisExecution, AnalysisError>> => {
      const owner: PendingOutputDirectoryCleanup = {
        operation,
        path: packageDirectory,
        identity: packageDirectoryIdentity,
        primary,
        remove: () =>
          removeOwnedOutputDirectory(
            packageDirectory,
            packageDirectoryIdentity,
          ),
      };
      try {
        await owner.remove();
      } catch (cause: unknown) {
        this.#pendingOutputDirectoryCleanup.add(owner);
        const cleanup = new ProviderCleanupError(
          ADB_PROVIDER_IDENTITY.id,
          [packageDirectory],
          { reason: cause instanceof Error ? cause.message : String(cause) },
          { operation, cause },
        );
        return err(
          analysisErrorWithCleanupFailure(primary, cleanup, operation),
        );
      }
      return err(primary);
    };
    const destinationError = await reservePackageDestinations(
      operation,
      packageDirectory,
      parsed.paths,
      capturedOutput,
    );
    if (destinationError !== undefined)
      return failOwnedPackage(destinationError);
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
    const cancelledPackagePull = (
      error: AnalysisCancelledError,
      localPath: string,
      devicePath: string,
      stage: "pull" | "digest",
    ) => {
      error.retainPartialObservation({
        provider_id: "adb",
        operation,
        result: {
          client,
          serial,
          package_name: packageName,
          output_directory: directory.value,
          artifacts,
          failures: [
            ...failures,
            {
              device_path: devicePath,
              stage,
              message:
                stage === "pull"
                  ? `Pull cancelled; any incomplete file is retained at ${localPath}. Remaining APKs were not attempted.`
                  : `Digesting the pulled file was cancelled; the file is retained at ${localPath}. Remaining APKs were not attempted.`,
            },
          ],
          coverage: "partial",
        },
      });
      return err(error);
    };
    for (const entry of parsed.paths) {
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
        if (pulled.error instanceof AnalysisCancelledError)
          return cancelledPackagePull(
            pulled.error,
            localPath,
            entry.device_path,
            "pull",
          );
        failures.push({
          device_path: entry.device_path,
          stage: "pull",
          message: pulled.error.message,
        });
        continue;
      }
      try {
        const digest = await hashAdbFile(localPath, operation, signal);
        artifacts.push({
          device_path: entry.device_path,
          file_name: entry.file_name,
          local_path: localPath,
          bytes: digest.bytes,
          sha256: digest.sha256,
          role: entry.role,
          role_basis: "file_name",
        });
      } catch (cause: unknown) {
        if (cause instanceof AnalysisCancelledError)
          return cancelledPackagePull(
            cause,
            localPath,
            entry.device_path,
            "digest",
          );
        failures.push({
          device_path: entry.device_path,
          stage: "digest",
          message: `The pulled file could not be read back after pulling: ${localPath}`,
        });
      }
    }
    if (artifacts.length === 0 && failures.length > 0) {
      const primary = new AnalysisProtocolError(
        `Every APK pull failed for ${packageName} on ${serial}: ${failures[0]!.message}`,
      );
      return failOwnedPackage(primary);
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
    const derived = adbHostFileName(input.device_path);
    if (!derived.ok)
      return err(
        new AnalysisInputError(operation, undefined, [
          {
            path: ["device_path"],
            reason: "invalid_value",
            message: `The device path ${JSON.stringify(input.device_path)} does not name a file that can be written on this host (${derived.reason}); REA never renames a device-reported file.`,
          },
        ]),
      );
    const directory = await prepareOutputDirectory(
      operation,
      input.output_directory,
    );
    if (!directory.ok) return directory;
    const localPath = join(directory.value, derived.fileName);
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
      const digest = await hashAdbFile(localPath, operation, signal);
      return ok(
        createAnalysisExecution(
          {
            client,
            serial: input.serial,
            device_path: input.device_path,
            local_path: localPath,
            bytes: digest.bytes,
            sha256: digest.sha256,
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
      if (cause instanceof AnalysisCancelledError) {
        cause.retainPartialObservation({
          provider_id: "adb",
          operation,
          result: {
            client,
            serial: input.serial,
            local_path: localPath,
            device_path: input.device_path,
            digest_status: "unknown",
          },
        });
        return err(cause);
      }
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
    let digest: Awaited<ReturnType<typeof hashAdbFile>>;
    try {
      digest = await hashAdbFile(localPath, operation, signal);
    } catch (cause: unknown) {
      if (cause instanceof AnalysisCancelledError) return err(cause);
      throw cause;
    }
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
      if (digestMatch !== null && digestMatch[1] !== digest.sha256)
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
            bytes: digest.bytes,
            sha256: digest.sha256,
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
          bytes: digest.bytes,
          sha256: digest.sha256,
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
    let digest: Awaited<ReturnType<typeof hashAdbFile>>;
    try {
      digest = await hashAdbFile(apkPath, operation, signal);
    } catch (cause: unknown) {
      if (cause instanceof AnalysisCancelledError) return err(cause);
      throw cause;
    }
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
          bytes: digest.bytes,
          sha256: digest.sha256,
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
    const verdict = parseAmStartOutput(
      started.value.stdout,
      started.value.stderr,
    );
    const result = {
      ...resultFields,
      started_activity: verdict.startedActivity,
      reported_activity: verdict.activity,
      reported_status: verdict.reportedStatus,
    };
    if (verdict.status === "refused") {
      const partialObservation: AdbActivityStartPartialObservation =
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
            };
      return err(
        new AnalysisUnsupportedTargetError(
          operation,
          serial,
          verdict.reason ?? "am start refused the intent",
          {
            capturedOutput: {
              stdout: started.value.stdout,
              stderr: started.value.stderr,
              truncated: false,
            },
            partialObservation,
          },
        ),
      );
    }
    return ok(
      createAnalysisExecution(result, provider, {
        rawResult: {
          stdout: started.value.stdout,
          stderr: started.value.stderr,
        },
        limitations: [
          "Starting an activity changes device state; am start -W waits for launch completion but no lifecycle observation is captured",
        ],
      }) as AnalysisExecution,
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
    const captured = await runAdbCapture(
      operation,
      input.serial,
      selection.binary,
      adbArguments(input.serial, ["exec-out", "screencap", "-p"]),
      { timeoutMs: SCREEN_TIMEOUT_MS, maxOutputBytes: SCREEN_MAX_OUTPUT_BYTES },
      signal,
    );
    if (!captured.ok) return captured;
    const dimensions = parsePngDimensions(captured.value.stdout);
    if (dimensions.width === null)
      return err(
        new AnalysisProtocolError(
          "screencap did not return a PNG payload; the device may not expose a display",
        ),
      );
    try {
      await writeFile(localPath, captured.value.stdout, { flag: "wx" });
    } catch (cause) {
      return err(
        new AnalysisOutputError(
          operation,
          `The screen output could not be created exclusively: ${localPath}`,
          { cause },
        ),
      );
    }
    const sha256 = createHash("sha256")
      .update(captured.value.stdout)
      .digest("hex");
    return ok(
      createAnalysisExecution(
        {
          client,
          serial: input.serial,
          local_path: localPath,
          bytes: captured.value.stdout.byteLength,
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
    let stagingDirectory: string;
    let stagingIdentity: OutputDirectoryIdentity | undefined;
    let retainedObservation: AdbAcquiredFilePartialObservation | undefined;
    let publishedPath: string | undefined;
    try {
      stagingDirectory = await mkdtemp(
        join(directory.value, ".rea-bugreport-"),
      );
    } catch (cause) {
      return err(
        new AnalysisOutputError(
          operation,
          "The bugreport staging directory could not be created",
          { cause },
        ),
      );
    }
    const collectedResult = await (async (): Promise<
      Result<AnalysisExecution, AnalysisError>
    > => {
      let reportedPath: string | null = null;
      try {
        const created = await lstat(stagingDirectory);
        if (!created.isDirectory() || created.isSymbolicLink())
          throw new Error(
            `The created bugreport staging output is not a regular directory: ${stagingDirectory}`,
          );
        stagingIdentity = {
          dev: created.dev,
          ino: created.ino,
          mode: created.mode,
        };
        const collected = await runAdb(
          operation,
          input.serial,
          selection.binary,
          adbArguments(input.serial, ["bugreport", stagingDirectory]),
          {
            timeoutMs: BUGREPORT_TIMEOUT_MS,
            maxOutputBytes: BUGREPORT_MAX_OUTPUT_BYTES,
          },
          signal,
        );
        if (!collected.ok) return collected;
        reportedPath = parseBugreportCopiedPath(collected.value.stdout);
        if (reportedPath === null)
          return err(
            new AnalysisProtocolError(
              "adb bugreport did not report an archive path; the build may use an unsupported format",
            ),
          );
        if (dirname(resolve(reportedPath)) !== stagingDirectory)
          return err(
            new AnalysisProtocolError(
              `adb bugreport reported an archive outside its staging directory: ${reportedPath}`,
            ),
          );
        const archive = await lstat(reportedPath);
        if (!archive.isFile() || archive.isSymbolicLink())
          return err(
            new AnalysisProtocolError(
              `adb bugreport did not report a regular archive file: ${reportedPath}`,
            ),
          );
        retainedObservation = {
          provider_id: "adb",
          operation,
          result: {
            client,
            serial: input.serial,
            local_path: reportedPath,
            adb_reported_path: reportedPath,
            digest_status: "unknown",
          },
        };
        try {
          publishedPath = await publishBugreport(reportedPath, directory.value);
        } catch (cause) {
          return err(
            new AnalysisOutputError(
              operation,
              `The reported bugreport archive could not be published: ${reportedPath}`,
              { cause, partialObservation: retainedObservation },
            ),
          );
        }
        retainedObservation = {
          ...retainedObservation,
          result: { ...retainedObservation.result, local_path: publishedPath },
        };
        const digest = await hashAdbFile(publishedPath, operation, signal);
        const report = {
          client,
          serial: input.serial,
          local_path: publishedPath,
          bytes: digest.bytes,
          sha256: digest.sha256,
          adb_reported_path: reportedPath,
        };
        retainedObservation = {
          provider_id: "adb",
          operation,
          result: report,
        };
        return ok(
          createAnalysisExecution(report, provider, {
            limitations: [
              "The archive is device-generated: dumpstate, dumpsys, and logcat content is the device's own report",
            ],
          }),
        );
      } catch (cause) {
        if (cause instanceof AnalysisCancelledError) {
          if (retainedObservation !== undefined)
            cause.retainPartialObservation(retainedObservation);
          return err(cause);
        }
        return err(
          new AnalysisOutputError(
            operation,
            `The reported bugreport archive could not be read back: ${reportedPath ?? stagingDirectory}`,
            { cause, partialObservation: retainedObservation },
          ),
        );
      }
    })();
    // A completed acquisition becomes caller evidence even if publication fails.
    // Its staging directory must not enter automatic cleanup or cleanup retries.
    if (retainedObservation !== undefined && publishedPath === undefined)
      return collectedResult;
    try {
      await removeOwnedOutputDirectory(stagingDirectory, stagingIdentity);
    } catch (cause) {
      const primary = collectedResult.ok
        ? new AnalysisOutputError(
            operation,
            "The archive was published, but its staging directory could not be removed",
          )
        : collectedResult.error;
      if (retainedObservation !== undefined)
        primary.retainPartialObservation(retainedObservation);
      this.#pendingOutputDirectoryCleanup.add({
        operation,
        path: stagingDirectory,
        identity: stagingIdentity,
        primary,
        remove: () =>
          removeOwnedOutputDirectory(stagingDirectory, stagingIdentity),
      });
      return err(
        analysisErrorWithCleanupFailure(
          primary,
          new ProviderCleanupError(
            ADB_PROVIDER_IDENTITY.id,
            [stagingDirectory],
            { reason: cause instanceof Error ? cause.message : String(cause) },
            { operation, cause },
          ),
          operation,
        ),
      );
    }
    return collectedResult;
  }
}
