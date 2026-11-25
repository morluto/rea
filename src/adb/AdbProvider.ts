import { unknownTarget } from "../domain/targetIdentity.js";
import { ADB_PROVIDER_IDENTITY } from "./AdbProviderIdentity.js";
import { HOST_PLATFORM } from "../platform/HostPlatform.js";
import {
  absoluteCallerPath,
  appendCallerPath,
} from "../filesystem/callerPath.js";
import type { AnalysisCapturedOutput } from "../domain/analysisErrorBase.js";
import { adbInputFileError } from "./AdbFilesystemAdmission.js";
import { analysisClientFailureForOperation } from "../providers/AnalysisClientFailure.js";
import { ownedProcessPrerequisiteAvailability } from "../providers/ownedProcessAvailability.js";
import { lstat, link, mkdtemp, mkdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import {
  type ExecutionOptions,
  type ProviderAvailability,
  createAnalysisExecution,
  type AnalysisExecution,
} from "../ports/AnalysisProvider.js";
import { providerConfigurationRefusal } from "../domain/providerConfigurationRefusal.js";
import { ADB_DEVICE_OBSERVATION_AUTHORITY } from "../domain/adb/adbDeviceAnalysis.js";
import type {
  AdbAcquiredFilePartialObservation,
  AdbPackagePullPartialObservation,
  AdbRequest,
} from "../domain/adb/adbDeviceAnalysis.js";
import {
  ArtifactReaderFailure,
  ArtifactResourceRetryFailure,
  ArtifactResourceScope,
  AnalysisCleanupLease,
  AnalysisCleanupLeaseGroup,
} from "../resources/index.js";
import {
  AnalysisArtifactChangedError,
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
  AnalysisProtocolError,
  AnalysisResourceConstraintError,
  AnalysisTimeoutError,
  cancelledBy,
  OwnerCancellation,
  isAborted,
  unsupportedTarget,
} from "../domain/analysisErrorCore.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  analysisErrorWithCleanupDependencies,
  analysisErrorWithCleanupFailure,
} from "../domain/analysisErrorCleanup.js";
import { analysisErrorWithCancellation } from "../domain/analysisErrorCancellation.js";
import { readPngHeaderDimensions } from "../domain/pngHeader.js";
import { err, ok, type Result } from "../domain/result.js";
import { finalizedResult, runOwned } from "../providers/runOwned.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { jsonObjectSchema } from "../domain/jsonValue.js";
import { stableFileHashCause } from "../filesystem/StableFileHash.js";
import { RegularFileCancelled } from "../filesystem/OwnedRegularFile.js";
import { createEvidence } from "../domain/evidence.js";
import { createAnalysisExecutionEvidence } from "../domain/analysisObservation.js";
import {
  PrivateRuntimeRoot,
  type PrivateRuntimeRootOptions,
} from "../process/PrivateRuntimeRoot.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import {
  RuntimeControlUnavailableError,
  runtimeControlCapabilityError,
} from "../domain/runtimeControlUnavailableError.js";
import {
  adbArguments,
  runAdb,
  runAdbCapture,
  packageChangeRefusal,
  probeAdbPathDirectory,
  probeAdbPathExistence,
  type AdbRunLimits,
} from "./AdbCommand.js";
import type { AdbCommandHost } from "./AdbProcess.js";
import { startAdbServer } from "./AdbServer.js";
import {
  AdbConfigurationFailure,
  adbConfigurationAvailability,
  inspectAdbClient,
  resolveAdbBinary,
  type AdbClientIdentity,
} from "./AdbConfiguration.js";
import { snapshotEnvironment } from "../process/snapshotEnvironment.js";
import { displayDevicePath, parsePmPathOutput } from "./AdbDeviceOutput.js";
import { adbHostFileName } from "./AdbHostFileName.js";
import {
  AdbInputSnapshotFailure,
  snapshotAdbInput,
} from "./AdbInputSnapshot.js";
import {
  parseBugreportCopiedPath,
  parsePackageChangeOutput,
  parseSha256sumOutput,
} from "./AdbShellOutput.js";
import {
  startAdbActivityOperation,
  startAdbAppOperation,
  stopAdbAppOperation,
  uninstallAdbPackageOperation,
} from "./AdbAppOperations.js";
import {
  clientIdentityResult,
  type AdbClientResult,
  type AdbProviderIdentity,
} from "./AdbOperationResults.js";
import {
  inspectAdbClientOperation,
  inspectAdbDeviceOperation,
  listAdbDevicesOperation,
  type AdbCommandContext,
} from "./AdbDeviceOperations.js";
import {
  inspectAdbDisplayOperation,
  inspectAdbPackageOperation,
  inspectAdbWindowOperation,
  listAdbDirectoryOperation,
  listAdbFeaturesOperation,
  listAdbPackagesOperation,
  listAdbProcessesOperation,
  listAdbServicesOperation,
  readAdbLogcatOperation,
  readAdbSettingOperation,
  resolveAdbPackagesOperation,
} from "./AdbShellOperations.js";
import {
  AdbDigestFailure,
  adbDigestError,
  hardLinksUnsupported,
  hashAdbFile,
  prepareOutputDirectory,
  publishBugreport,
  publishScreenExclusively,
  refuseExistingTarget,
  removeOwnedOutputDirectory,
  reservePackageDestinations,
  runtimeRootLease,
  syncStagedAdbFile,
  type AdbDeviceDigest,
  type AdbRuntimeRoot,
  type OutputDirectoryIdentity,
  type PendingOutputDirectoryCleanup,
  type ScreenPublicationCloseFailure,
} from "./AdbFileStaging.js";
import { errorMessage } from "../kernel/errorMessage.js";
import { sha256Hex } from "../kernel/sha256Hex.js";

const SHELL_TIMEOUT_MS = 30_000;
const PM_PATH_TIMEOUT_MS = 30_000;
const PM_PATH_MAX_OUTPUT_BYTES = 64 * 1024;
const PULL_TIMEOUT_MS = 600_000;
const PULL_MAX_OUTPUT_BYTES = 1024 * 1024;
const SETTINGS_TIMEOUT_MS = 20_000;
const SCREEN_TIMEOUT_MS = 60_000;
const SCREEN_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const BUGREPORT_TIMEOUT_MS = 600_000;
const BUGREPORT_MAX_OUTPUT_BYTES = 1024 * 1024;

/**
 * Commit an ADB observation as Evidence that names the device's authority. Every
 * retained receipt and partial travels through here so none can fall back to the
 * subject-derived default for a target REA does not own.
 */
const createObservationEvidence = (
  operation: string,
  parameters: Record<string, JsonValue>,
  execution: AnalysisExecution,
) =>
  createAnalysisExecutionEvidence(
    operation,
    parameters,
    {
      ...execution,
      authority: execution.authority ?? ADB_DEVICE_OBSERVATION_AUTHORITY,
    },
    "observed",
  );

/**
 * Stamp the device's authority on every successful execution at the adapter
 * boundary, so a caller-projected or retained observation cannot fall back to a
 * subject-derived authority for a target REA does not own.
 */
const observedExecution = (
  result: Result<AnalysisExecution, AnalysisError>,
): Result<AnalysisExecution, AnalysisError> =>
  result.ok
    ? ok({
        ...result.value,
        authority: result.value.authority ?? ADB_DEVICE_OBSERVATION_AUTHORITY,
      })
    : result;

export interface AdbProviderOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  /** Override runtime-root creation at the provider's owned-resource boundary. */
  readonly createRuntimeRoot?: (
    options?: PrivateRuntimeRootOptions,
  ) => Promise<AdbRuntimeRoot>;
  /** The host adb and its pulled files live on; defaults to the running host. */
  readonly platform?: NodeJS.Platform;
}

/**
 * ADB device inspection and acquisition over a caller-selected adb binary.
 *
 * Every operation composes fixed adb argument vectors: caller values occupy
 * positional arguments, escaped when adb forwards them to the device shell.
 * The provider never starts an emulator, installs platform tools, or drives
 * the device UI. Some operations mutate device state; a caller-requested file
 * push requires an explicit overwrite choice and verifies its transfer digest
 * when the device provides `sha256sum`.
 */
export class AdbProvider {
  private readonly environment: Readonly<Record<string, string | undefined>>;
  private readonly platform: NodeJS.Platform;
  readonly #createRuntimeRoot: (
    options?: PrivateRuntimeRootOptions,
  ) => Promise<AdbRuntimeRoot>;
  readonly #resources = new ArtifactResourceScope();
  readonly #outputDirectoryRetryLeases = new WeakMap<
    AnalysisError,
    readonly AnalysisCleanupLease[]
  >();
  readonly #pendingOutputDirectoryCleanup =
    new Set<PendingOutputDirectoryCleanup>();
  readonly #activeOperations = new Set<Promise<void>>();
  #closing = false;
  #closePromise: Promise<void> | undefined;
  #outputCleanupPromise: Promise<void> | undefined;

  constructor(options: AdbProviderOptions = {}) {
    this.platform = options.platform ?? HOST_PLATFORM.platform;
    this.environment = snapshotEnvironment(
      options.environment ?? process.env,
      this.platform,
    );
    this.#createRuntimeRoot =
      options.createRuntimeRoot ??
      ((rootOptions) => PrivateRuntimeRoot.create(rootOptions));
  }

  /** The selected adb binary, with this provider retaining its commands' unfinished cleanup. */
  private async selection(signal?: AbortSignal): Promise<AdbCommandHost> {
    return {
      ...(await resolveAdbBinary(this.environment, this.platform, signal)),
      resources: this.#resources,
    };
  }

  /** Probe the selected adb binary; never contacts devices or the server. */
  async inspectAvailability(
    signal?: AbortSignal,
  ): Promise<ProviderAvailability> {
    if (this.#closing)
      throw cancelledBy(
        "inspect_adb_client",
        isAborted(signal) ? signal : OwnerCancellation.ownerClosed,
      );
    if (signal?.aborted === true)
      throw cancelledBy("inspect_adb_client", signal);
    const release = this.#beginOperation();
    try {
      const retried = await this.#retryPendingCleanup("inspect_adb_client", {});
      if (!retried.ok) throw retried.error;
      const selection = await this.selection(signal);
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
      const prerequisite = ownedProcessPrerequisiteAvailability(cause);
      if (prerequisite !== undefined) return prerequisite;
      throw cause;
    } finally {
      release();
    }
  }

  /** Keep admitted probes and requests owned until their final cleanup settles. */
  #beginOperation(): () => void {
    let release!: () => void;
    const active = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#activeOperations.add(active);
    return () => {
      this.#activeOperations.delete(active);
      release();
    };
  }

  /** Retry removal of owned output directories retained after failed cleanup. */
  close(): Promise<void> {
    this.#closing = true;
    if (this.#closePromise !== undefined) return this.#closePromise;
    const closing = (async () => {
      await Promise.all(this.#activeOperations);
      const failures: unknown[] = [];
      const failedLeases = new Set<AnalysisCleanupLease>();
      let allFailuresHaveExactLeaseOwners = true;
      // Directory errors may also depend on a retained digest descriptor.
      // Settle those owners before deciding whether the directory error resolved.
      for (const cleanup of [
        () => this.#resources.close(),
        () => this.#retryOutputDirectoryCleanup(),
      ]) {
        try {
          await cleanup();
        } catch (cause: unknown) {
          failures.push(cause);
          const leases =
            (cause instanceof AnalysisError
              ? this.#outputDirectoryRetryLeases.get(cause)
              : undefined) ??
            (cause instanceof ArtifactResourceRetryFailure
              ? cause.cleanupLeases
              : undefined);
          if (leases === undefined) allFailuresHaveExactLeaseOwners = false;
          for (const lease of leases ?? []) failedLeases.add(lease);
        }
      }
      if (failures.length > 0) {
        const resources = failures.flatMap((cause) =>
          this.#cleanupResources(cause, "ADB provider-owned resource"),
        );
        const error = new ProviderCleanupError(
          ADB_PROVIDER_IDENTITY.id,
          [...new Set(resources)],
          {
            reason: failures.map((cause) => errorMessage(cause)).join("; "),
          },
          {
            operation: "close_binary",
            cause: new AggregateError(
              failures,
              "ADB cleanup remains incomplete",
            ),
          },
        );
        if (allFailuresHaveExactLeaseOwners && failedLeases.size > 0)
          new AnalysisCleanupLeaseGroup(error, [...failedLeases]);
        throw error;
      }
    })().finally(() => {
      if (this.#closePromise === closing) this.#closePromise = undefined;
    });
    this.#closePromise = closing;
    return this.#closePromise;
  }

  #cleanupResources(cause: unknown, resource: string): readonly string[] {
    if (cause instanceof ArtifactReaderFailure && cause.cleanup !== undefined)
      return cause.cleanup.resources;
    if (cause instanceof AnalysisError && cause.cleanupResources.length > 0)
      return cause.cleanupResources;
    return [resource];
  }

  #cleanupError(
    operation: string,
    parameters: Record<string, JsonValue>,
    causes: readonly unknown[],
    resources: readonly string[],
    execution?: AnalysisExecution,
  ): ProviderCleanupError {
    const partialObservation =
      execution === undefined
        ? undefined
        : createObservationEvidence(operation, parameters, execution);
    return new ProviderCleanupError(
      ADB_PROVIDER_IDENTITY.id,
      resources,
      {
        reason: causes.map((cause) => errorMessage(cause)).join("; "),
      },
      {
        operation,
        cause: new AggregateError(causes, "ADB operation cleanup failed"),
        ...(partialObservation === undefined ? {} : { partialObservation }),
      },
    );
  }

  async #withRuntimeRoot(
    operation: string,
    parameters: Record<string, JsonValue>,
    options: PrivateRuntimeRootOptions,
    signal: AbortSignal | undefined,
    work: (
      root: AdbRuntimeRoot,
      children: ArtifactResourceScope,
    ) => Promise<Result<AnalysisExecution, AnalysisError>>,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    let root: AdbRuntimeRoot;
    try {
      root = await this.#createRuntimeRoot(options);
    } catch (cause: unknown) {
      return err(
        cause instanceof AnalysisError
          ? cause
          : cause instanceof RuntimeControlUnavailableError
            ? runtimeControlCapabilityError(
                ADB_PROVIDER_IDENTITY.id,
                operation,
                cause,
              )
            : new AnalysisOutputError(
                operation,
                "Could not create an ADB private workspace",
                {
                  cause,
                },
              ),
      );
    }

    const children = new ArtifactResourceScope();
    const rootLease = runtimeRootLease(root, children);
    return finalizedResult(
      await runOwned(
        async () => {
          try {
            return await work(root, children);
          } catch (cause: unknown) {
            if (!(cause instanceof AdbInputSnapshotFailure))
              return err(
                cause instanceof AnalysisError
                  ? cause
                  : new AnalysisProtocolError(`ADB ${operation} failed`, {
                      cause,
                    }),
              );
            const primary =
              cause.primaryCause instanceof AnalysisError
                ? cause.primaryCause
                : new AnalysisOutputError(
                    operation,
                    `The caller input could not be staged for adb: ${cause.sourcePath}`,
                    { cause: cause.primaryCause ?? cause },
                  );
            // Snapshot handle cleanup may recover when the runtime-root lease
            // is drained during close. Keep that historical failure linked to
            // the typed primary error while the lease owns live cleanup state.
            return err(
              primary.retainSecondaryFailure(
                new AnalysisOutputError(
                  operation,
                  `ADB input snapshot cleanup previously failed for ${cause.sourcePath}`,
                  { cause },
                ),
                {},
              ),
            );
          }
        },
        {
          providerId: ADB_PROVIDER_IDENTITY.id,
          operation,
          signal,
          close: async () => {
            const released = await this.#resources.release({
              kind: "lease",
              resource: root.path,
              lease: rootLease,
            });
            if (released.kind === "released") return;
            const cleanup = this.#cleanupError(
              operation,
              parameters,
              [released.cause],
              [
                root.path,
                ...(released.cause instanceof ArtifactReaderFailure &&
                released.cause.cleanup !== undefined
                  ? released.cause.cleanup.resources
                  : []),
              ],
            );
            rootLease.bindCleanupError(cleanup);
            cleanup.bindCleanupResourceOwner(rootLease);
            throw cleanup;
          },
          partial: (completed) =>
            createObservationEvidence(operation, parameters, completed),
        },
      ),
    );
  }

  #retainOutputDirectoryCleanup(
    owner: Omit<PendingOutputDirectoryCleanup, "lease">,
    cleanup: ProviderCleanupError,
  ): AnalysisError {
    const liveResources = () => [
      ...new Set([
        owner.path,
        ...(owner.resources?.() ?? []),
        ...(owner.primary.cleanupIncomplete
          ? owner.primary.cleanupResources
          : []),
      ]),
    ];
    const lease = new AnalysisCleanupLease(
      async () => {
        await owner.remove();
        if (owner.primary.cleanupIncomplete)
          throw new Error(
            "ADB output directory primary cleanup remains incomplete",
          );
      },
      {
        get cleanupResources() {
          return liveResources();
        },
      },
    );
    const error = analysisErrorWithCleanupFailure(
      owner.primary,
      cleanup,
      owner.operation,
    );
    lease.bindCleanupError(error);
    error.bindCleanupResourceOwner(lease);
    this.#pendingOutputDirectoryCleanup.add({ ...owner, lease });
    return error;
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
        await owner.lease.release();
        this.#pendingOutputDirectoryCleanup.delete(owner);
      } catch (cause: unknown) {
        const cleanup = new ProviderCleanupError(
          ADB_PROVIDER_IDENTITY.id,
          owner.lease.cleanupResources ?? [owner.path],
          {
            reason: errorMessage(cause),
          },
          { operation: owner.operation, cause },
        );
        const error = analysisErrorWithCleanupFailure(
          owner.primary,
          cleanup,
          owner.operation,
        );
        owner.lease.bindCleanupError(error);
        error.bindCleanupResourceOwner(owner.lease);
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      const error =
        failures.length === 1
          ? failures[0]!
          : new ProviderCleanupError(
              ADB_PROVIDER_IDENTITY.id,
              [
                ...new Set(
                  failures.flatMap((failure) => failure.cleanupResources),
                ),
              ],
              {
                reason:
                  "Failed ADB output directories remain after cleanup retry",
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
      const leases = [...this.#pendingOutputDirectoryCleanup].map(
        ({ lease }) => lease,
      );
      this.#outputDirectoryRetryLeases.set(error, leases);
      if (failures.length > 1) new AnalysisCleanupLeaseGroup(error, leases);
      throw error;
    }
  }

  async execute(
    request: AdbRequest,
    options?: ExecutionOptions,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    if (this.#closing)
      return err(cancelledBy(request.operation, OwnerCancellation.ownerClosed));
    const release = this.#beginOperation();
    try {
      const retried = await this.#retryPendingCleanup(
        request.operation,
        jsonObjectSchema.parse(request.input),
      );
      if (!retried.ok) return retried;
      return observedExecution(await this.#executeOperation(request, options));
    } finally {
      release();
    }
  }

  async #retryPendingCleanup(
    operation: AdbRequest["operation"],
    input: Readonly<Record<string, JsonValue>>,
  ): Promise<Result<null, AnalysisError>> {
    try {
      await this.#resources.retryCleanup();
    } catch (cause: unknown) {
      const error = this.#cleanupError(
        operation,
        input,
        [cause],
        this.#cleanupResources(cause, "ADB provider-owned resource"),
      );
      const leases =
        cause instanceof ArtifactResourceRetryFailure
          ? cause.cleanupLeases
          : undefined;
      if (leases !== undefined) new AnalysisCleanupLeaseGroup(error, leases);
      return err(error);
    }
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
                  reason: errorMessage(cause),
                },
                { operation, cause },
              ),
        );
      }
    }
    return ok(null);
  }

  async #executeOperation(
    request: AdbRequest,
    options?: ExecutionOptions,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    const signal = options?.signal;
    if (signal?.aborted === true)
      return err(cancelledBy(request.operation, signal));
    let selection: AdbCommandHost;
    let identity: AdbClientIdentity;
    try {
      selection = await this.selection(signal);
      identity = await inspectAdbClient(selection, signal);
    } catch (cause) {
      if (cause instanceof AnalysisError)
        return err(
          analysisClientFailureForOperation(
            cause,
            ADB_PROVIDER_IDENTITY.id,
            request.operation,
            { prerequisite_operation: "inspect_adb_client" },
          ),
        );
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
    // Device operations reach the shared adb server, which REA may start
    // once local inputs/outputs are admitted, and never stops.
    let serverStarted:
      | Promise<Result<{ readonly daemonStarted: boolean }, AnalysisError>>
      | undefined;
    if (request.operation !== "inspect_adb_client") {
      const baseSelection = selection;
      selection = {
        ...baseSelection,
        startServer: () =>
          (serverStarted ??= startAdbServer(
            request.operation,
            baseSelection,
            signal,
          )),
      };
    }
    const client = clientIdentityResult(selection, identity);
    const provider: AdbProviderIdentity = {
      ...ADB_PROVIDER_IDENTITY,
      version: identity.version,
    };
    const { operation } = request;
    const shell = (arguments_: readonly string[], limits: AdbRunLimits) =>
      runAdb(
        operation,
        {
          device: "serial" in request.input ? request.input.serial : operation,
        },
        selection,
        adbArguments(
          "serial" in request.input ? request.input.serial : undefined,
          ["shell", ...arguments_],
        ),
        { ...limits, volatileOutput: true },
        signal,
      );
    const context: AdbCommandContext = {
      operation,
      request,
      selection,
      client,
      provider,
      signal,
      shell,
    };
    switch (operation) {
      case "inspect_adb_client":
        return inspectAdbClientOperation(context);
      case "list_adb_devices":
        return listAdbDevicesOperation(context);
      case "inspect_adb_device":
        return inspectAdbDeviceOperation(context);
      case "list_adb_packages":
        return listAdbPackagesOperation({ ...context, operation, request });
      case "pull_adb_package":
        return this.pullPackage(
          operation,
          selection,
          client,
          provider,
          request.input,
          signal,
        );
      case "read_adb_logcat":
        return readAdbLogcatOperation({ ...context, operation, request });
      case "inspect_adb_package":
        return inspectAdbPackageOperation({ ...context, operation, request });
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
      case "list_adb_processes":
        return listAdbProcessesOperation({ ...context, operation, request });
      case "list_adb_directory":
        return listAdbDirectoryOperation({ ...context, operation, request });
      case "list_adb_features":
        return listAdbFeaturesOperation({ ...context, operation, request });
      case "list_adb_services":
        return listAdbServicesOperation({ ...context, operation, request });
      case "inspect_adb_display":
        return inspectAdbDisplayOperation({ ...context, operation, request });
      case "inspect_adb_window":
        return inspectAdbWindowOperation({ ...context, operation, request });
      case "read_adb_setting":
        return readAdbSettingOperation({ ...context, operation, request });
      case "resolve_adb_packages":
        return resolveAdbPackagesOperation({ ...context, operation, request });
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
        return uninstallAdbPackageOperation(
          operation,
          selection,
          client,
          provider,
          request.input,
          signal,
        );
      case "start_adb_app":
        return startAdbAppOperation(
          operation,
          selection,
          client,
          provider,
          request.input,
          signal,
        );
      case "start_adb_activity":
        return startAdbActivityOperation(
          operation,
          selection,
          client,
          provider,
          request.input,
          signal,
        );
      case "stop_adb_app":
        return stopAdbAppOperation(
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
    selection: AdbCommandHost,
    client: AdbClientResult,
    provider: AdbProviderIdentity,
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
      { device: serial },
      selection,
      adbArguments(serial, ["shell", "pm", "path", packageName]),
      {
        timeoutMs: PM_PATH_TIMEOUT_MS,
        maxOutputBytes: PM_PATH_MAX_OUTPUT_BYTES,
        volatileOutput: true,
      },
      signal,
    );
    if (!paths.ok) return paths;
    const parsed = parsePmPathOutput(paths.value.stdout, this.platform);
    const capturedOutput = {
      stdout: paths.value.stdout,
      stderr: paths.value.stderr,
      truncated: false,
    };
    if (parsed.rejectedPaths.length > 0) {
      const first = parsed.rejectedPaths[0]!;
      const otherCount = parsed.rejectedPaths.length - 1;
      return err(
        new AnalysisOutputError(operation, "unsafe_device_path", {
          capturedOutput,
          userMessage: `pm path for ${packageName} reported an APK path that cannot be written as a file on this host: ${displayDevicePath(first.device_path)} (${first.reason})${otherCount > 0 ? ` and ${String(otherCount)} other path(s)` : ""}. No APK was pulled.`,
          remediationAction:
            "Review details.diagnostics for the refused device paths and details.captured_output for the retained pm path output. REA does not rename device-reported APK paths; correct the device path policy before retrying.",
          diagnostics: {
            package_name: packageName,
            rejected_paths: parsed.rejectedPaths.map(
              ({ device_path, reason }) => ({
                device_path,
                reason,
              }),
            ),
          },
        }),
      );
    }
    if (parsed.paths.length === 0 && parsed.unparsedLines.total === 0)
      return err(
        unsupportedTarget(
          operation,
          serial,
          "android-package",
          `Package Manager reported no APK paths for ${packageName}; it may not be installed for user 0`,
        ),
      );
    if (parsed.unparsedLines.total > 0)
      return err(
        new AnalysisProtocolError(
          `pm path reported an unrecognized line: ${parsed.unparsedLines.sample[0]!}`,
          { capturedOutput },
        ),
      );
    const destinationNames = new Set<string>();
    for (const entry of parsed.paths) {
      if (destinationNames.has(entry.file_name))
        return err(
          new AnalysisOutputError(operation, "duplicate_local_destination", {
            capturedOutput,
            userMessage: `pm path for ${packageName} reported multiple APK paths with the same local file name ${displayDevicePath(entry.file_name)}; no APK was pulled.`,
            remediationAction:
              "Review details.diagnostics and details.captured_output for the conflicting device paths. REA does not rename device-reported paths; correct Package Manager's path response before retrying.",
            diagnostics: {
              package_name: packageName,
              file_name: entry.file_name,
              device_paths: parsed.paths
                .filter((candidate) => candidate.file_name === entry.file_name)
                .map((candidate) => candidate.device_path),
            },
          }),
        );
      destinationNames.add(entry.file_name);
    }
    const directory = await prepareOutputDirectory(
      operation,
      input.output_directory,
    );
    if (!directory.ok) return directory;
    const packageDirectory = appendCallerPath(directory.value, packageName);
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
      const primary = new AnalysisOutputError(operation, errorMessage(cause), {
        cause,
      });
      if (!packageDirectoryCreated) return err(primary);
      const owner = {
        operation,
        path: packageDirectory,
        primary,
        remove: () =>
          removeOwnedOutputDirectory(
            packageDirectory,
            packageDirectoryIdentity,
          ),
      };
      const cleanup = new ProviderCleanupError(
        ADB_PROVIDER_IDENTITY.id,
        [packageDirectory],
        {
          reason: "Could not establish an owned package directory identity",
        },
        { operation, cause },
      );
      return err(this.#retainOutputDirectoryCleanup(owner, cleanup));
    }
    const failOwnedPackage = async (
      primary: AnalysisError,
    ): Promise<Result<AnalysisExecution, AnalysisError>> => {
      const owner = {
        operation,
        path: packageDirectory,
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
        const cleanup = new ProviderCleanupError(
          ADB_PROVIDER_IDENTITY.id,
          [packageDirectory],
          { reason: errorMessage(cause) },
          { operation, cause },
        );
        return err(this.#retainOutputDirectoryCleanup(owner, cleanup));
      }
      return err(primary);
    };
    const destinationError = await reservePackageDestinations(
      operation,
      packageName,
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
      cause: unknown;
    }[] = [];
    const observedFailures = () =>
      failures.map(({ device_path, stage, message }) => ({
        device_path,
        stage,
        message,
      }));
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
            ...observedFailures(),
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
      const localPath = appendCallerPath(packageDirectory, entry.file_name);
      const pulled = await runAdb(
        operation,
        {
          device: serial,
          path: entry.device_path,
          localPath,
        },
        selection,
        adbArguments(serial, ["pull", entry.device_path, localPath]),
        { timeoutMs: PULL_TIMEOUT_MS, maxOutputBytes: PULL_MAX_OUTPUT_BYTES },
        signal,
      );
      if (!pulled.ok) {
        if (pulled.error.cleanupIncomplete) {
          pulled.error.retainPartialObservation({
            provider_id: "adb",
            operation,
            result: {
              client,
              serial,
              package_name: packageName,
              output_directory: directory.value,
              artifacts,
              failures: [
                ...observedFailures(),
                {
                  device_path: entry.device_path,
                  stage: "pull",
                  message: `Pull cleanup remains incomplete; any incomplete file is retained at ${localPath}. Remaining APKs were not attempted.`,
                },
              ],
              coverage: "partial",
            },
          });
          return err(pulled.error);
        }
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
          cause: pulled.error,
        });
        continue;
      }
      try {
        const digest = await hashAdbFile(
          localPath,
          operation,
          signal,
          this.#resources,
        );
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
        const digestFailure =
          cause instanceof AdbDigestFailure ? cause.fileFailure : undefined;
        const completedDigest =
          digestFailure?.outcome.kind === "completed"
            ? digestFailure.outcome.value
            : undefined;
        const partialObservation: AdbPackagePullPartialObservation = {
          provider_id: "adb",
          operation,
          result: {
            client,
            serial,
            package_name: packageName,
            output_directory: directory.value,
            artifacts:
              completedDigest === undefined
                ? artifacts
                : [
                    ...artifacts,
                    {
                      device_path: entry.device_path,
                      file_name: entry.file_name,
                      local_path: localPath,
                      bytes: completedDigest.bytes,
                      sha256: completedDigest.sha256,
                      role: entry.role,
                      role_basis: "file_name",
                    },
                  ],
            failures: [
              ...observedFailures(),
              {
                device_path: entry.device_path,
                stage: "digest",
                message:
                  completedDigest === undefined
                    ? `The pulled file remains at ${localPath}, but its digest and descriptor cleanup are unconfirmed.`
                    : digestFailure instanceof RegularFileCancelled
                      ? `The pulled file digest and descriptor cleanup are confirmed; the request was cancelled: ${localPath}`
                      : `The pulled file digest is known, but its descriptor cleanup is unconfirmed: ${localPath}`,
              },
            ],
            coverage: "partial",
          },
        };
        if (cause instanceof AdbDigestFailure)
          return err(adbDigestError(cause, operation, partialObservation));
        if (cause instanceof AnalysisCancelledError)
          return cancelledPackagePull(
            cause,
            localPath,
            entry.device_path,
            "digest",
          );
        const physicalCause = stableFileHashCause(cause);
        failures.push({
          device_path: entry.device_path,
          stage: "digest",
          message: `The pulled file could not be read back after pulling: ${localPath}: ${errorMessage(physicalCause)}`,
          cause,
        });
      }
    }
    if (artifacts.length === 0 && failures.length > 0) {
      const firstCause = failures[0]!.cause;
      const primary =
        firstCause instanceof AnalysisError
          ? firstCause
          : new AnalysisProtocolError(
              `Every APK pull failed for ${packageName} on ${serial}: ${failures[0]!.message}`,
              {
                cause: new AggregateError(
                  failures.map(({ cause }) => cause),
                  "APK pulls failed",
                ),
              },
            );
      primary.retainPartialObservation({
        provider_id: "adb",
        operation,
        result: {
          client,
          serial,
          package_name: packageName,
          output_directory: directory.value,
          artifacts,
          failures: observedFailures(),
          coverage: "partial",
        },
      });
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
          failures: observedFailures(),
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
    selection: AdbCommandHost,
    client: AdbClientResult,
    provider: AdbProviderIdentity,
    input: {
      readonly serial: string;
      readonly device_path: string;
      readonly output_directory: string;
    },
    signal: AbortSignal | undefined,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    const derived = adbHostFileName(input.device_path, this.platform);
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
    const localPath = appendCallerPath(directory.value, derived.fileName);
    const existing = await refuseExistingTarget(operation, localPath);
    if (existing !== undefined) return err(existing);
    const pulled = await runAdb(
      operation,
      {
        device: input.serial,
        path: input.device_path,
        localPath,
      },
      selection,
      adbArguments(input.serial, ["pull", input.device_path, localPath]),
      { timeoutMs: PULL_TIMEOUT_MS, maxOutputBytes: PULL_MAX_OUTPUT_BYTES },
      signal,
    );
    if (!pulled.ok) {
      // A failed adb process can leave caller-visible bytes at the selected
      // destination. Report only an observed regular file; its transfer and
      // digest are unconfirmed, and the caller owns the output.
      const output = await lstat(localPath).catch(() => undefined);
      if (output?.isFile() === true && !output.isSymbolicLink())
        pulled.error.retainPartialObservation({
          provider_id: "adb",
          operation,
          result: {
            client,
            serial: input.serial,
            local_path: localPath,
            device_path: input.device_path,
            digest_status: "unknown",
            transfer_status: "unconfirmed",
          },
        });
      return pulled;
    }
    try {
      const digest = await hashAdbFile(
        localPath,
        operation,
        signal,
        this.#resources,
      );
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
      const partialObservation: AdbAcquiredFilePartialObservation = {
        provider_id: "adb",
        operation,
        result: {
          client,
          serial: input.serial,
          local_path: localPath,
          device_path: input.device_path,
          digest_status: "unknown",
        },
      };
      if (cause instanceof AdbDigestFailure)
        return err(adbDigestError(cause, operation, partialObservation));
      if (cause instanceof AnalysisCancelledError) {
        cause.retainPartialObservation(partialObservation);
        return err(cause);
      }
      return err(
        new AnalysisOutputError(
          operation,
          `The pulled file could not be read back after pulling: ${localPath}`,
          { cause, partialObservation },
        ),
      );
    }
  }

  private async pushFile(
    operation: "push_adb_file",
    selection: AdbCommandHost,
    client: AdbClientResult,
    provider: AdbProviderIdentity,
    input: {
      readonly serial: string;
      readonly local_path: string;
      readonly device_path: string;
      readonly overwrite: boolean;
    },
    signal: AbortSignal | undefined,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    const localPath = absoluteCallerPath(input.local_path);
    const invalid = await adbInputFileError(
      operation,
      "local_path",
      input.local_path,
      localPath,
    );
    if (invalid !== undefined) return err(invalid);
    return this.#withRuntimeRoot(
      operation,
      {
        serial: input.serial,
        local_path: localPath,
        device_path: input.device_path,
        overwrite: input.overwrite,
      },
      { prefix: "rea-adb-input-" },
      signal,
      async (root, resources) => {
        const digest = await snapshotAdbInput(
          localPath,
          root,
          resources,
          operation,
          signal,
        );
        const scopedSelection: AdbCommandHost = { ...selection, resources };
        const directoryProbe = await probeAdbPathDirectory(
          operation,
          input.serial,
          input.device_path,
          scopedSelection,
          { timeoutMs: SETTINGS_TIMEOUT_MS, maxOutputBytes: 1024 },
          signal,
        );
        if (!directoryProbe.ok) return directoryProbe;
        const devicePath = directoryProbe.value.matches
          ? `${input.device_path}${input.device_path.endsWith("/") ? "" : "/"}${basename(localPath)}`
          : input.device_path;
        const existsProbe = await probeAdbPathExistence(
          operation,
          input.serial,
          devicePath,
          scopedSelection,
          { timeoutMs: SETTINGS_TIMEOUT_MS, maxOutputBytes: 1024 },
          signal,
        );
        if (!existsProbe.ok) return existsProbe;
        const deviceExists = existsProbe.value.matches;
        if (deviceExists && !input.overwrite)
          return err(
            new AnalysisOutputError(
              operation,
              `The device path already exists and overwrite was not requested: ${devicePath}`,
            ),
          );
        const pushed = await runAdb(
          operation,
          {
            device: input.serial,
            path: input.device_path,
            localPath: digest.path,
          },
          scopedSelection,
          adbArguments(input.serial, ["push", digest.path, input.device_path]),
          { timeoutMs: PULL_TIMEOUT_MS, maxOutputBytes: PULL_MAX_OUTPUT_BYTES },
          signal,
        );
        if (!pushed.ok) return pushed;
        const observedProbeStartup =
          directoryProbe.value.capturedOutput.stderr !== "" ||
          existsProbe.value.capturedOutput.stderr !== "";
        const probeOutput = observedProbeStartup
          ? {
              device_path_probes: {
                directory: { ...directoryProbe.value.capturedOutput },
                existence: { ...existsProbe.value.capturedOutput },
              },
            }
          : undefined;
        const receipt = (
          deviceDigest: AdbDeviceDigest,
          rawResult?: {
            readonly device_sha256sum: {
              readonly stdout: string;
              readonly stderr: string;
            };
          },
        ) =>
          createAnalysisExecution(
            {
              client,
              serial: input.serial,
              local_path: localPath,
              device_path: devicePath,
              bytes: digest.bytes,
              sha256: digest.sha256,
              device_sha256: deviceDigest.device_sha256,
              overwritten: deviceExists,
              device_digest_source: deviceDigest.device_digest_source,
            },
            provider,
            {
              ...(rawResult === undefined && probeOutput === undefined
                ? {}
                : { rawResult: { ...rawResult, ...probeOutput } }),
              limitations: [
                "Push writes a private snapshot of the caller's file to the device",
                ...(deviceDigest.device_digest_source === "unavailable"
                  ? [deviceDigest.reason]
                  : []),
              ],
            },
          );
        const deviceDigest = await runAdb(
          operation,
          { device: input.serial, path: devicePath },
          scopedSelection,
          adbArguments(input.serial, ["shell", "sha256sum", devicePath]),
          {
            timeoutMs: SHELL_TIMEOUT_MS,
            // sha256sum echoes the path, escaping special characters, so a
            // long path must not exhaust the budget for the digest line.
            maxOutputBytes: 1024 + 2 * Buffer.byteLength(devicePath),
          },
          signal,
        );
        if (!deviceDigest.ok) {
          const cancelled =
            deviceDigest.error instanceof AnalysisCancelledError;
          const cleanupIncomplete = deviceDigest.error.cleanupIncomplete;
          // The check never started and the push already completed, so a
          // retryable error would invite a repeat that overwrite=false refuses.
          const hostCapacity =
            deviceDigest.error instanceof AnalysisResourceConstraintError &&
            deviceDigest.error.resource === "capacity";
          const verificationFailed =
            cancelled ||
            cleanupIncomplete ||
            (!hostCapacity &&
              (deviceDigest.error instanceof AnalysisResourceConstraintError ||
                deviceDigest.error instanceof AnalysisTimeoutError));
          const completed = receipt({
            device_sha256: null,
            device_digest_source: "unavailable",
            reason: cancelled
              ? "The device-side digest check was cancelled after push completed"
              : verificationFailed
                ? `Device-side digest verification failed after push completed: ${deviceDigest.error.message}`
                : hostCapacity
                  ? `Push completed, but the transfer is not device-side verified: ${deviceDigest.error.reason}`
                  : "The device did not answer sha256sum, so the transfer is not device-side verified",
          });
          if (verificationFailed)
            deviceDigest.error.retainPartialObservation(
              createEvidence(
                completed.subject ?? unknownTarget("not-observed"),
                completed.provider,
                {
                  operation,
                  parameters: input,
                  result: completed.result,
                  rawResult: completed.rawResult,
                  limitations: completed.limitations,
                  locations: completed.locations,
                  confidence: "observed",
                  authority:
                    completed.authority ?? ADB_DEVICE_OBSERVATION_AUTHORITY,
                },
              ),
            );
          return verificationFailed ? err(deviceDigest.error) : ok(completed);
        }
        const parsedDigest = parseSha256sumOutput(deviceDigest.value.stdout);
        const completed =
          parsedDigest === null
            ? receipt(
                {
                  device_sha256: null,
                  device_digest_source: "unavailable",
                  reason:
                    "The device's sha256sum output contained no recognizable digest, so the transfer is not device-side verified",
                },
                {
                  device_sha256sum: {
                    stdout: deviceDigest.value.stdout,
                    stderr: deviceDigest.value.stderr,
                  },
                },
              )
            : receipt({
                device_sha256: parsedDigest,
                device_digest_source: "device_sha256sum",
              });
        if (parsedDigest !== null && parsedDigest !== digest.sha256)
          return err(
            new AnalysisArtifactChangedError(
              operation,
              devicePath,
              `The device-reported digest does not match the staged local file: ${localPath}`,
              {
                partialObservation: createEvidence(
                  completed.subject ?? unknownTarget("not-observed"),
                  completed.provider,
                  {
                    operation,
                    parameters: input,
                    result: completed.result,
                    rawResult: completed.rawResult,
                    limitations: completed.limitations,
                    locations: completed.locations,
                    confidence: "observed",
                    authority:
                      completed.authority ?? ADB_DEVICE_OBSERVATION_AUTHORITY,
                  },
                ),
              },
            ),
          );
        return ok(completed);
      },
    );
  }

  private async installPackage(
    operation: "install_adb_package",
    selection: AdbCommandHost,
    client: AdbClientResult,
    provider: AdbProviderIdentity,
    input: {
      readonly serial: string;
      readonly apk_path: string;
      readonly replace: boolean;
    },
    signal: AbortSignal | undefined,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    const apkPath = absoluteCallerPath(input.apk_path);
    const invalid = await adbInputFileError(
      operation,
      "apk_path",
      input.apk_path,
      apkPath,
    );
    if (invalid !== undefined) return err(invalid);
    return this.#withRuntimeRoot(
      operation,
      {
        serial: input.serial,
        apk_path: apkPath,
        replace: input.replace,
      },
      { prefix: "rea-adb-apk-" },
      signal,
      async (root, resources) => {
        const digest = await snapshotAdbInput(
          apkPath,
          root,
          resources,
          operation,
          signal,
        );
        const scopedSelection: AdbCommandHost = { ...selection, resources };
        const installed = await runAdb(
          operation,
          { device: input.serial, path: apkPath, localPath: digest.path },
          scopedSelection,
          adbArguments(input.serial, [
            "install",
            ...(input.replace ? ["-r"] : []),
            digest.path,
          ]),
          { timeoutMs: PULL_TIMEOUT_MS, maxOutputBytes: PULL_MAX_OUTPUT_BYTES },
          signal,
        );
        if (!installed.ok)
          return (
            packageChangeRefusal(operation, input.serial, installed.error) ??
            installed
          );
        const verdict = parsePackageChangeOutput(installed.value.stdout);
        if (verdict.status === "unknown")
          return err(
            new AnalysisOutputError(
              operation,
              "ADB returned no installation verdict",
              {
                capturedOutput: {
                  stdout: installed.value.stdout,
                  stderr: installed.value.stderr,
                  truncated: false,
                },
              },
            ),
          );
        if (verdict.status === "failure")
          return err(
            unsupportedTarget(
              operation,
              input.serial,
              "android-package",
              verdict.reason,
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
              replace_requested: input.replace,
              replaced: null,
            },
            provider,
            {
              limitations: [
                "Install changes device state; the installed APK's digest identifies the private host snapshot",
                "Whether an existing package was replaced is unknown; replace_requested records only the adb install mode",
              ],
            },
          ),
        );
      },
    );
  }

  private async captureScreen(
    operation: "capture_adb_screen",
    selection: AdbCommandHost,
    client: AdbClientResult,
    provider: AdbProviderIdentity,
    input: { readonly serial: string; readonly output_directory: string },
    signal: AbortSignal | undefined,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    const directory = await prepareOutputDirectory(
      operation,
      input.output_directory,
    );
    if (!directory.ok) return directory;
    const localPath = appendCallerPath(directory.value, "screen.png");
    const existing = await refuseExistingTarget(operation, localPath);
    if (existing !== undefined) return err(existing);
    const captured = await runAdbCapture(
      operation,
      { device: input.serial },
      selection,
      adbArguments(input.serial, ["exec-out", "screencap", "-p"]),
      {
        timeoutMs: SCREEN_TIMEOUT_MS,
        maxOutputBytes: SCREEN_MAX_OUTPUT_BYTES,
        volatileOutput: true,
      },
      signal,
    );
    if (!captured.ok) return captured;
    if (signal?.aborted === true) return err(cancelledBy(operation, signal));
    const dimensions = readPngHeaderDimensions(captured.value.stdout);
    if (dimensions === undefined)
      return err(
        new AnalysisProtocolError(
          "screencap returned an invalid PNG header; the device may not expose a display",
        ),
      );
    return this.#withRuntimeRoot(
      operation,
      { serial: input.serial, output_directory: directory.value },
      { parent: directory.value, prefix: ".rea-screen-" },
      signal,
      async (stage, resources) => {
        let publicationCloseFailure: ScreenPublicationCloseFailure | undefined;
        let usedExclusiveFallback = false;
        try {
          const stagedPath = join(stage.path, "screen.png");
          await writeFile(stagedPath, captured.value.stdout, { flag: "wx" });
          await syncStagedAdbFile(stagedPath, resources, operation);
          if (signal?.aborted === true)
            return err(cancelledBy(operation, signal));
          try {
            // A same-filesystem hard link atomically publishes without replacing
            // caller output. Its success is the publication cutoff.
            await link(stagedPath, localPath);
          } catch (cause: unknown) {
            if (!hardLinksUnsupported(cause)) throw cause;
            // Exclusive creation prevents replacement, but makes the path
            // visible while the fallback writes the complete file.
            usedExclusiveFallback = true;
            publicationCloseFailure =
              (await publishScreenExclusively(
                localPath,
                captured.value.stdout,
                resources,
                operation,
                signal,
              )) ?? undefined;
          }
        } catch (cause: unknown) {
          if (cause instanceof AnalysisError) return err(cause);
          return err(
            new AnalysisOutputError(
              operation,
              `The screen output could not be published exclusively: ${localPath}`,
              { cause },
            ),
          );
        }
        const sha256 = sha256Hex(captured.value.stdout);
        const completed = createAnalysisExecution(
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
              "PNG signature, IHDR framing, checksum, dimensions, and encoding fields are validated. Pixel data remains undecoded",
              ...(usedExclusiveFallback
                ? [
                    "The exclusive-create fallback makes the output path visible while its bytes are being written",
                  ]
                : []),
            ],
          },
        );
        if (publicationCloseFailure !== undefined) {
          const cleanupError = this.#cleanupError(
            operation,
            { serial: input.serial, output_directory: directory.value },
            [publicationCloseFailure.cause],
            [publicationCloseFailure.resource],
            completed,
          );
          publicationCloseFailure.bindCleanupError(cleanupError);
          return err(cleanupError);
        }
        return ok(completed);
      },
    );
  }

  private async collectBugreport(
    operation: "collect_adb_bugreport",
    selection: AdbCommandHost,
    client: AdbClientResult,
    provider: AdbProviderIdentity,
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
        appendCallerPath(directory.value, ".rea-bugreport-"),
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
    const commandResources = new ArtifactResourceScope();
    const collectedResult = await (async (): Promise<
      Result<AnalysisExecution, AnalysisError>
    > => {
      let reportedPath: string | null = null;
      let commandFailure: AnalysisError | undefined;
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
          { device: input.serial },
          { ...selection, resources: commandResources },
          adbArguments(input.serial, ["bugreport", stagingDirectory]),
          {
            timeoutMs: BUGREPORT_TIMEOUT_MS,
            maxOutputBytes: BUGREPORT_MAX_OUTPUT_BYTES,
          },
          signal,
        );
        if (!collected.ok) commandFailure = collected.error;
        const completedStdout = collected.ok
          ? collected.value.stdout
          : collected.error.capturedOutput?.exit_code === 0 &&
              !collected.error.capturedOutput.truncated
            ? collected.error.capturedOutput.stdout
            : undefined;
        if (completedStdout === undefined)
          return collected as Result<never, AnalysisError>;
        reportedPath = parseBugreportCopiedPath(completedStdout);
        if (reportedPath === null)
          return collected.ok
            ? err(
                new AnalysisProtocolError(
                  "adb bugreport did not report an archive path; the build may use an unsupported format",
                ),
              )
            : collected;
        const reportedParent = await stat(
          dirname(absoluteCallerPath(reportedPath)),
        );
        if (
          !reportedParent.isDirectory() ||
          reportedParent.dev !== stagingIdentity.dev ||
          reportedParent.ino !== stagingIdentity.ino
        )
          return collected.ok
            ? err(
                new AnalysisProtocolError(
                  `adb bugreport reported an archive outside its staging directory: ${reportedPath}`,
                ),
              )
            : collected;
        const archive = await lstat(reportedPath);
        if (!archive.isFile() || archive.isSymbolicLink())
          return collected.ok
            ? err(
                new AnalysisProtocolError(
                  `adb bugreport did not report a regular archive file: ${reportedPath}`,
                ),
              )
            : collected;
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
          const publishError = new AnalysisOutputError(
            operation,
            `The reported bugreport archive could not be published: ${reportedPath}`,
            { cause, partialObservation: retainedObservation },
          );
          if (!collected.ok) {
            collected.error.retainPartialObservation(retainedObservation);
            return err(
              collected.error.retainSecondaryFailure(publishError, {}),
            );
          }
          return err(publishError);
        }
        retainedObservation = {
          ...retainedObservation,
          result: { ...retainedObservation.result, local_path: publishedPath },
        };
        if (
          !collected.ok &&
          collected.error instanceof AnalysisCancelledError
        ) {
          collected.error.retainPartialObservation(retainedObservation);
          return collected;
        }
        const digest = await hashAdbFile(
          publishedPath,
          operation,
          signal,
          this.#resources,
        );
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
        if (!collected.ok) {
          collected.error.retainPartialObservation(retainedObservation);
          return collected;
        }
        return ok(
          createAnalysisExecution(report, provider, {
            limitations: [
              "The archive is device-generated: dumpstate, dumpsys, and logcat content is the device's own report",
            ],
          }),
        );
      } catch (cause) {
        const readbackFailure =
          retainedObservation !== undefined && cause instanceof AdbDigestFailure
            ? adbDigestError(cause, operation, retainedObservation)
            : cause instanceof AnalysisCancelledError
              ? (() => {
                  if (retainedObservation !== undefined)
                    cause.retainPartialObservation(retainedObservation);
                  return cause;
                })()
              : new AnalysisOutputError(
                  operation,
                  `The reported bugreport archive could not be read back: ${reportedPath ?? stagingDirectory}`,
                  { cause, partialObservation: retainedObservation },
                );
        if (readbackFailure.partialObservation !== undefined)
          retainedObservation =
            readbackFailure.partialObservation as AdbAcquiredFilePartialObservation;
        if (commandFailure !== undefined) {
          if (retainedObservation !== undefined)
            commandFailure.retainPartialObservation(retainedObservation);
          return err(
            readbackFailure.cleanupIncomplete
              ? analysisErrorWithCleanupDependencies(
                  commandFailure,
                  readbackFailure,
                  operation,
                )
              : readbackFailure instanceof AnalysisCancelledError
                ? analysisErrorWithCancellation(commandFailure, readbackFailure)
                : commandFailure.retainSecondaryFailure(readbackFailure, {}),
          );
        }
        return err(readbackFailure);
      }
    })();
    const retainCancellation = (failure: AnalysisError | undefined) =>
      signal?.aborted === true
        ? analysisErrorWithCancellation(
            failure,
            cancelledBy(operation, signal, {
              partialObservation: retainedObservation,
            }),
          )
        : failure;
    // A completed acquisition becomes caller evidence even if publication fails.
    // Its staging directory must not enter automatic cleanup or cleanup retries.
    if (retainedObservation !== undefined && publishedPath === undefined) {
      if (commandResources.hasPending)
        this.#resources.retain({
          kind: "lease",
          resource: `${stagingDirectory} (ADB bugreport command)`,
          lease: AnalysisCleanupLease.forCloseOwner(
            {
              close: () => commandResources.retryCleanup(),
              get cleanupResources() {
                return commandResources.cleanupResources;
              },
            },
            `${stagingDirectory} (ADB bugreport command)`,
          ),
        });
      return collectedResult.ok
        ? collectedResult
        : err(
            retainCancellation(collectedResult.error) ?? collectedResult.error,
          );
    }
    const removeStaging = async () => {
      await commandResources.retryCleanup();
      await removeOwnedOutputDirectory(stagingDirectory, stagingIdentity);
    };
    try {
      if (commandResources.hasPending)
        throw new Error(
          "ADB bugreport command cleanup remains unconfirmed; retaining staging directory",
        );
      await removeOwnedOutputDirectory(stagingDirectory, stagingIdentity);
    } catch (cause) {
      const primary =
        retainCancellation(
          collectedResult.ok ? undefined : collectedResult.error,
        ) ??
        new AnalysisOutputError(
          operation,
          "The archive was published, but its staging directory could not be removed",
        );
      if (retainedObservation !== undefined)
        primary.retainPartialObservation(retainedObservation);
      return err(
        this.#retainOutputDirectoryCleanup(
          {
            operation,
            path: stagingDirectory,
            primary,
            remove: removeStaging,
            resources: () => commandResources.cleanupResources,
          },
          new ProviderCleanupError(
            ADB_PROVIDER_IDENTITY.id,
            [
              ...new Set([
                stagingDirectory,
                ...commandResources.cleanupResources,
                ...(primary.cleanupIncomplete ? primary.cleanupResources : []),
              ]),
            ],
            { reason: errorMessage(cause) },
            { operation, cause },
          ),
        ),
      );
    }
    const failure = retainCancellation(
      collectedResult.ok ? undefined : collectedResult.error,
    );
    return failure === undefined ? collectedResult : err(failure);
  }
}
