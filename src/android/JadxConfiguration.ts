import type { HostPlatform } from "../platform/HostPlatform.js";
import {
  absoluteCallerPath,
  appendCallerPath,
} from "../filesystem/callerPath.js";
import {
  DEFAULT_JADX_OPERATION_TIMEOUT_MS,
  MAX_NODE_TIMER_DELAY_MS,
} from "../domain/analysisResourceLimits.js";
import {
  jadxOperationTimeoutGuidance,
  JADX_OPERATION_TIMEOUT_REMEDIATION,
} from "./JadxOperationTimeout.js";
import { inspectJadxJava, type JadxJavaProbeOptions } from "./JadxJavaProbe.js";
import {
  JadxInterruption,
  throwIfJadxInterrupted,
} from "./JadxInterruption.js";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { isAbsolute, posix, win32 } from "node:path";
import {
  posixPathCandidates,
  windowsPathCandidates,
  type PathSearchCandidate,
} from "../process/executableSearch.js";
import { inspectWindowsNativeReadiness } from "../process/WindowsAuthority.js";
import { systemWindowsNativeAuthority } from "../windows/WindowsNativeLoader.js";
import { providerStartupTimeoutSchema } from "../config/providerStartupTimeout.js";
import {
  AnalysisTimeoutError,
  AnalysisCapabilityUnavailableError,
  cancelledBy,
  carriedReason,
} from "../domain/analysisErrorCore.js";
import type { AndroidOperation } from "../domain/android/androidAnalysis.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { err, ok, type Result } from "../domain/result.js";
import type { ProviderAvailability } from "../ports/AnalysisProvider.js";
import { ownedProcessPrerequisiteAvailability } from "../providers/ownedProcessAvailability.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import { analysisErrorWithCleanupDependencies } from "../domain/analysisErrorCleanup.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import {
  ArtifactReaderFailure,
  ArtifactFileCancelled,
  ArtifactFileCleanupFailure,
  bindArtifactFileCleanup,
  withArtifactRegularFile,
  ZipArtifactReader,
} from "../resources/index.js";
import { analysisClientFailureForOperation } from "../providers/AnalysisClientFailure.js";
import type { DoctorProviderCheck } from "../ports/DoctorProviderInspection.js";
import {
  JADX_JAR_CONFIGURATION_REMEDIATION,
  JADX_JAVA_PROBE_REMEDIATION,
  JADX_JAVA_RUNTIME_REMEDIATION,
  JADX_JVM_OPTIONS_REMEDIATION,
  JADX_UNSUPPORTED_HOST_REMEDIATION,
  JADX_WINDOWS_NATIVE_REMEDIATION,
} from "./JadxRelease.js";
import { errorMessage } from "../kernel/errorMessage.js";

// Bound ZIP metadata allocation during discovery. The audited 0.7.1 JAR's
// central directory occupies 2,294,350 bytes; class bodies are not read here.
const JAR_METADATA_READ_MAX_BYTES = 8 * 1024 * 1024;

/** Caller-supplied tools, resolved only when an Android operation is selected. */
export interface JadxConfiguration {
  readonly jar: string;
  readonly java: string;
  readonly jvmArguments: readonly string[];
}

type ConfigurationFailureCode =
  | "not_configured"
  | "executable_missing"
  | "runtime_missing"
  | "runtime_unavailable"
  | "unsupported_host"
  | "unsupported_version"
  | "version_unresolved"
  | "open_options_invalid";

/**
 * Failure kinds tagged at the JADX configuration boundary. Availability
 * carries the boundary's remediation for a kind and the doctor adapter
 * projects its classification; neither reinterprets the phase/setting
 * evidence to derive them.
 */
export type JadxFailureKind =
  | "windows_native_artifact"
  | "windows_native_runtime"
  | "java_runtime"
  | "java_home"
  | "jvm_options"
  | "operation_timeout"
  | "jar"
  | "java_probe"
  | "unsupported_host";

/** Runtime mirror of JadxFailureKind for validating the loose diagnostics tag. */
export const JADX_FAILURE_KINDS: readonly JadxFailureKind[] = [
  "windows_native_artifact",
  "windows_native_runtime",
  "java_runtime",
  "java_home",
  "jvm_options",
  "operation_timeout",
  "jar",
  "java_probe",
  "unsupported_host",
];

/** The boundary-owned repair instruction for one tagged failure kind. */
const jadxFailureRemediation = (kind: JadxFailureKind): string => {
  switch (kind) {
    case "windows_native_artifact":
    case "windows_native_runtime":
      return JADX_WINDOWS_NATIVE_REMEDIATION;
    case "java_runtime":
    case "java_home":
      return JADX_JAVA_RUNTIME_REMEDIATION;
    case "jvm_options":
      return JADX_JVM_OPTIONS_REMEDIATION;
    case "operation_timeout":
      return JADX_OPERATION_TIMEOUT_REMEDIATION;
    case "jar":
      return JADX_JAR_CONFIGURATION_REMEDIATION;
    case "java_probe":
      return JADX_JAVA_PROBE_REMEDIATION;
    case "unsupported_host":
      return JADX_UNSUPPORTED_HOST_REMEDIATION;
  }
};

/**
 * Project the doctor classification for a failure kind. A null kind (an
 * untagged readiness failure) is classified as configuration drift.
 */
export const jadxFailureClassification = (
  kind: JadxFailureKind | null,
  configured: boolean,
): DoctorProviderCheck["classification"] => {
  const drift = configured ? "config_drift" : "missing_analysis_engine";
  switch (kind) {
    case "windows_native_artifact":
    case "java_runtime":
      return "missing_dependency";
    case "windows_native_runtime":
      return "runtime_failure";
    case "unsupported_host":
      return "unsupported_host";
    case "java_home":
    case "jvm_options":
    case "operation_timeout":
    case "jar":
    case "java_probe":
    case null:
      return drift;
  }
};

class JadxConfigurationFailure extends Error {
  constructor(
    readonly code: ConfigurationFailureCode,
    message: string,
    readonly diagnostics: Readonly<Record<string, JsonValue>>,
    readonly kind: JadxFailureKind,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/** Inspect the same JAR and Java prerequisites that gate actual execution. */
export const inspectJadxAvailability = async (
  environment: Readonly<Record<string, string | undefined>>,
  options: JadxJavaProbeOptions & {
    /** The host whose process-ownership controls and Java layout apply. */
    readonly host: HostPlatform;
    /** Admitted runtime override; omission retains launch configuration. */
    readonly operationTimeoutMs?: number | undefined;
  },
): Promise<ProviderAvailability> => {
  try {
    const operationTimeoutMs = readOperationTimeout(
      environment,
      options.operationTimeoutMs,
    );
    const configuration = await readJadxConfigurationInputs(
      environment,
      options.host,
      options.signal,
    );
    await validateJadxConfigurationContents(
      configuration,
      environment,
      options,
    );
    return {
      status: "available",
      code: null,
      reason: null,
      diagnostics: {
        configured: true,
        java_executable: configuration.java,
        jdk_compiler: true,
        jar_path: configuration.jar,
        operation_timeout_ms: operationTimeoutMs,
      },
    };
  } catch (cause) {
    if (cause instanceof JadxInterruption)
      throw cancelledBy(
        options.operation ?? "inspect_jadx_configuration",
        carriedReason(cause.reason),
      );
    if (cause instanceof JadxConfigurationFailure)
      return {
        status: "unavailable",
        code: cause.code,
        reason: cause.message,
        remediation: jadxFailureRemediation(cause.kind),
        diagnostics: { ...cause.diagnostics, failure_kind: cause.kind },
      };
    const prerequisite = ownedProcessPrerequisiteAvailability(cause);
    if (prerequisite !== undefined) return prerequisite;
    throw cause;
  }
};

/**
 * Resolve the whole-operation deadline before any admission work starts, so
 * one value bounds the provider operation and each upstream call.
 */
export const resolveJadxOperationTimeout = (
  environment: Readonly<Record<string, string | undefined>>,
  operation: AndroidOperation,
  runtimeTimeoutMs?: number,
): Result<number, AnalysisCapabilityUnavailableError> => {
  try {
    return ok(readOperationTimeout(environment, runtimeTimeoutMs));
  } catch (cause) {
    if (!(cause instanceof JadxConfigurationFailure)) throw cause;
    return err(projectConfigurationFailure(operation, cause));
  }
};

/** Resolve caller-selected paths and JVM options without probing their contents. */
export const resolveJadxConfigurationInputs = async (
  environment: Readonly<Record<string, string | undefined>>,
  operation: AndroidOperation,
  host: HostPlatform,
  signal?: AbortSignal,
): Promise<JadxConfiguration> => {
  try {
    return await readJadxConfigurationInputs(environment, host, signal);
  } catch (cause) {
    if (!(cause instanceof JadxConfigurationFailure)) throw cause;
    throw projectConfigurationFailure(operation, cause);
  }
};

/** Probe Java and archive prerequisites before starting a new engine session. */
export const validateJadxConfiguration = async (
  configuration: JadxConfiguration,
  environment: Readonly<Record<string, string | undefined>>,
  operation: AndroidOperation,
  options: JadxJavaProbeOptions,
): Promise<void> => {
  try {
    await validateJadxConfigurationContents(configuration, environment, {
      ...options,
      operation,
    });
  } catch (cause) {
    if (!(cause instanceof JadxConfigurationFailure)) throw cause;
    throw projectConfigurationFailure(operation, cause);
  }
};

const readJadxConfigurationInputs = async (
  environment: Readonly<Record<string, string | undefined>>,
  host: HostPlatform,
  signal?: AbortSignal,
): Promise<JadxConfiguration> => {
  throwIfJadxInterrupted(signal);
  requireSupportedHost(host);
  const jar = await resolveJar(environment);
  const java = await resolveJava(environment, host.platform, signal);
  await requireJavaHomeExecutable(environment.JAVA_HOME, java);
  throwIfJadxInterrupted(signal);
  return { jar, java, jvmArguments: resolveJvmArguments(environment) };
};

const validateJadxConfigurationContents = async (
  configuration: JadxConfiguration,
  environment: Readonly<Record<string, string | undefined>>,
  options: JadxJavaProbeOptions,
): Promise<void> => {
  throwIfJadxInterrupted(options.signal);
  await inspectJavaRuntime(configuration.java, environment, options);
  await requireEngineArchive(configuration.jar, options);
};

const projectConfigurationFailure = (
  operation: string,
  cause: JadxConfigurationFailure,
): AnalysisCapabilityUnavailableError => {
  const output = cause.diagnostics;
  const { stdout: _stdout, stderr: _stderr, ...facts } = output;
  return new AnalysisCapabilityUnavailableError(
    "jadx",
    operation,
    cause.message,
    {
      cause,
      userMessage: cause.message,
      diagnostics: {
        ...facts,
        failure_kind: cause.kind,
        failure_code: cause.code,
      },
      ...(typeof output.stdout === "string" && typeof output.stderr === "string"
        ? {
            capturedOutput: {
              stdout: output.stdout,
              stderr: output.stderr,
              truncated: output.output_truncated === true,
            },
          }
        : {}),
    },
  );
};

const requireEngineArchive = async (
  jar: string,
  options: JadxJavaProbeOptions,
): Promise<void> => {
  const operation = options.operation ?? "inspect_jadx_configuration";
  try {
    await options.resourceOwner.run(() =>
      withArtifactRegularFile(
        jar,
        {
          retain: ({ lease, resource }) =>
            options.resourceOwner.retain(
              {
                close: () => lease.release(),
              },
              resource,
            ),
        },
        options.signal,
        async ({ handle, initial }) => {
          try {
            // Metadata enumeration borrows this descriptor. The file workflow
            // alone owns admission, final close, cancellation and failed retry.
            const reader = new ZipArtifactReader(
              jar,
              "zip",
              JAR_METADATA_READ_MAX_BYTES,
              { handle, initial },
            );
            const missing = new Set([
              "com/atxx/jhmcp/JadxSession.class",
              "com/atxx/jhmcp/SessionHolder.class",
              "jadx/api/JadxDecompiler.class",
              "com/google/gson/Gson.class",
              "io/modelcontextprotocol/kotlin/sdk/server/Server.class",
            ]);
            for await (const entry of reader.entries(options.signal)) {
              if (entry.kind === "file" && !entry.encrypted)
                missing.delete(entry.path);
              if (missing.size === 0) return;
            }
            throw configurationFailure(
              "unsupported_version",
              `REA_JADX_MCP_JAR ${jar} does not contain the required metadata bridge classes: ${[...missing].join(", ")}. ${JADX_JAR_CONFIGURATION_REMEDIATION}`,
              {
                jar_path: jar,
                phase: "jar-inspection",
                missing_classes: [...missing],
              },
              "jar",
            );
          } catch (cause: unknown) {
            if (
              cause instanceof JadxConfigurationFailure ||
              (cause instanceof ArtifactReaderFailure &&
                cause.reason === "cancelled")
            )
              throw cause;
            throw archiveInspectionFailure(jar, cause);
          }
        },
      ),
    );
  } catch (cause: unknown) {
    if (cause instanceof ArtifactFileCleanupFailure) {
      const physical = cause.fileCleanupFailure;
      const cleanup = new ProviderCleanupError(
        "jadx",
        [jar],
        {
          phase: "jar-inspection",
          ...(physical.outcome.kind === "completed"
            ? { archive_observation: { jar_path: jar, required_classes: true } }
            : {}),
        },
        { operation, cause: physical.cleanupCause },
      );
      bindArtifactFileCleanup(cause, cleanup);
      const primary =
        physical.outcome.kind === "failed"
          ? archiveAnalysisFailure(jar, physical.outcome.cause, options)
          : physical.completionCancellation === undefined
            ? undefined
            : archiveCancellation(
                physical.completionCancellation.reason,
                options,
                {
                  archive_observation: {
                    jar_path: jar,
                    required_classes: true,
                  },
                },
              );
      if (primary === undefined) throw cleanup;
      throw analysisErrorWithCleanupDependencies(primary, cleanup, operation);
    }
    if (cause instanceof ArtifactFileCancelled) {
      throw archiveCancellation(cause.fileCancellation.reason, options, {
        archive_observation: { jar_path: jar, required_classes: true },
      });
    }
    if (cause instanceof ArtifactReaderFailure) {
      if (cause.reason === "cancelled")
        throw archiveCancellation(cause.cancellation?.reason, options);
      throw analysisClientFailureForOperation(cause, "jadx", operation);
    }
    if (
      cause instanceof AnalysisError ||
      cause instanceof JadxConfigurationFailure
    )
      throw cause;
    throw archiveInspectionFailure(jar, cause);
  }
};

const archiveInspectionFailure = (jar: string, cause: unknown) => {
  const reason = errorMessage(cause);
  return configurationFailure(
    "version_unresolved",
    `Cannot inspect REA_JADX_MCP_JAR ${jar} as a Java archive: ${reason}. ${JADX_JAR_CONFIGURATION_REMEDIATION}`,
    {
      jar_path: jar,
      phase: "jar-inspection",
      archive_error: reason,
      maximum_metadata_read_bytes: JAR_METADATA_READ_MAX_BYTES,
    },
    "jar",
    cause,
  );
};

const archiveAnalysisFailure = (
  jar: string,
  cause: unknown,
  options: JadxJavaProbeOptions,
): AnalysisError => {
  if (cause instanceof AnalysisError) return cause;
  if (cause instanceof ArtifactReaderFailure && cause.reason === "cancelled")
    return archiveCancellation(cause.cancellation?.reason, options);
  return projectConfigurationFailure(
    options.operation ?? "inspect_jadx_configuration",
    cause instanceof JadxConfigurationFailure
      ? cause
      : archiveInspectionFailure(jar, cause),
  );
};

const archiveCancellation = (
  reason: unknown,
  options: JadxJavaProbeOptions,
  diagnostics?: Readonly<Record<string, JsonValue>>,
) => {
  const operation = options.operation ?? "inspect_jadx_configuration";
  return options.operationDeadline?.signal.aborted === true &&
    reason === options.operationDeadline.signal.reason
    ? new AnalysisTimeoutError(operation, options.operationDeadline.timeoutMs, {
        cause: reason,
        diagnostics,
        ...jadxOperationTimeoutGuidance(options.operationDeadline.timeoutMs),
      })
    : cancelledBy(operation, carriedReason(reason), { diagnostics });
};

const requireSupportedHost = (host: HostPlatform): void => {
  const { platform, architecture } = host;
  if (platform === "linux" || platform === "darwin") return;
  if (
    platform === "win32" &&
    (architecture === "x64" || architecture === "arm64")
  ) {
    const loaded = systemWindowsNativeAuthority(host);
    if (loaded.available) {
      if (loaded.authority.inspection.protocolStdin === true) return;
      throw configurationFailure(
        "runtime_missing",
        "The bundled Windows native artifact lacks owned protocol stdin; use a matching current Windows REA package for this architecture.",
        {
          platform: platform,
          architecture: architecture,
          phase: "process-ownership",
          owned_protocol_stdin: false,
        },
        "windows_native_artifact",
      );
    }
    const readiness = inspectWindowsNativeReadiness(platform, loaded);
    throw configurationFailure(
      readiness.available ? "runtime_unavailable" : readiness.code,
      readiness.available
        ? "Windows native readiness disagreed with the native loader result."
        : readiness.reason,
      {
        platform: platform,
        architecture: architecture,
        phase: "process-ownership",
        owned_protocol_stdin: false,
        ...(readiness.available
          ? {}
          : {
              failure_stage: readiness.failureStage,
              remediation: readiness.remediation,
            }),
      },
      readiness.available
        ? "windows_native_runtime"
        : readiness.code === "unsupported_host"
          ? "unsupported_host"
          : readiness.code === "runtime_missing"
            ? "windows_native_artifact"
            : "windows_native_runtime",
    );
  }
  throw configurationFailure(
    "unsupported_host",
    `Android JADX subprocess ownership is unsupported on ${platform}/${architecture}; use Linux, macOS, or Windows x64/arm64 with its bundled native controls.`,
    { platform: platform },
    "unsupported_host",
  );
};

const resolveJar = async (
  environment: Readonly<Record<string, string | undefined>>,
): Promise<string> => {
  const jar = environment.REA_JADX_MCP_JAR;
  if (jar === undefined)
    throw configurationFailure(
      "not_configured",
      JADX_JAR_CONFIGURATION_REMEDIATION,
      { jar_configured: false },
      "jar",
    );
  // A supplied selection stays configured even when rejected, so callers can
  // tell it from an omitted setting and see the exact value REA refused.
  if (!isAbsolute(jar))
    throw configurationFailure(
      "open_options_invalid",
      `REA_JADX_MCP_JAR must be an absolute path; received ${JSON.stringify(jar)}. ${JADX_JAR_CONFIGURATION_REMEDIATION}`,
      { jar_configured: true, jar_path: jar, path_requirement: "absolute" },
      "jar",
    );
  try {
    await access(jar, constants.R_OK);
    if (!(await stat(jar)).isFile())
      throw configurationFailure(
        "executable_missing",
        `REA_JADX_MCP_JAR is not a regular file: ${jar}`,
        { jar_path: jar },
        "jar",
      );
    return await realpath(jar);
  } catch (cause) {
    if (cause instanceof JadxConfigurationFailure) throw cause;
    throw configurationFailure(
      "executable_missing",
      `Cannot read REA_JADX_MCP_JAR ${jar}: ${errorMessage(cause)}`,
      { jar_path: jar },
      "jar",
      cause,
    );
  }
};

const resolveJava = async (
  environment: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
  signal?: AbortSignal,
): Promise<string> => {
  const windows = platform === "win32";
  const executable = windows ? "java.exe" : "java";
  if (environment.JAVA_HOME === undefined) {
    // Resolve in the caller's directory once. The module probe and the engine
    // run in different directories, and the selected executable also owns the
    // retained session's cache identity. Empty POSIX PATH components select
    // cwd. `java.exe` names its extension, so PATHEXT never fails the search.
    const windowsSearch = windows
      ? windowsPathCandidates(executable, environment)
      : undefined;
    const candidates: Iterable<PathSearchCandidate> =
      windowsSearch === undefined
        ? posixPathCandidates(executable, environment.PATH ?? "/usr/bin:/bin", {
            relativeEntries: "resolve",
          })
        : windowsSearch.ok
          ? windowsSearch.value
          : [];
    for (const { path: candidate } of candidates) {
      throwIfJadxInterrupted(signal);
      try {
        await access(
          candidate,
          windows ? constants.R_OK | constants.X_OK : constants.X_OK,
        );
        if ((await stat(candidate)).isFile())
          return windows ? await realpath(candidate) : candidate;
      } catch (cause: unknown) {
        if (
          typeof cause === "object" &&
          cause !== null &&
          "code" in cause &&
          (cause.code === "ENOENT" ||
            cause.code === "ENOTDIR" ||
            (!windows && (cause.code === "EACCES" || cause.code === "EPERM")))
        )
          continue;
        throw configurationFailure(
          "runtime_missing",
          `Cannot inspect selected Java executable ${candidate}: ${errorMessage(cause)}`,
          { java_executable: candidate },
          "java_runtime",
          cause,
        );
      }
    }
    throw configurationFailure(
      "runtime_missing",
      `Cannot find an executable ${executable} on the selected ${windows ? "Windows " : ""}PATH. Select a full JDK with JAVA_HOME or PATH, then verify it with java --list-modules. REA does not install Java.`,
      { java_executable: executable, phase: "path-lookup" },
      "java_runtime",
    );
  }
  // JAVA_HOME follows the same host path rules as the PATH search above.
  if ((windows ? win32 : posix).isAbsolute(environment.JAVA_HOME))
    return appendCallerPath(
      environment.JAVA_HOME,
      `bin/${executable}`,
      platform,
    );
  throw configurationFailure(
    "open_options_invalid",
    "JAVA_HOME must select an existing JDK by absolute path; omit it to use java on PATH.",
    { java_home: environment.JAVA_HOME },
    "java_home",
  );
};

const requireJavaHomeExecutable = async (
  javaHome: string | undefined,
  java: string,
): Promise<void> => {
  if (javaHome === undefined) return;
  try {
    await access(java, constants.R_OK | constants.X_OK);
    if ((await stat(java)).isFile()) return;
    throw configurationFailure(
      "runtime_missing",
      `JAVA_HOME java is not a regular file: ${java}`,
      { java_executable: java },
      "java_runtime",
    );
  } catch (cause) {
    if (cause instanceof JadxConfigurationFailure) throw cause;
    throw configurationFailure(
      "runtime_missing",
      `Cannot execute JAVA_HOME java ${java}: ${errorMessage(cause)}`,
      { java_executable: java },
      "java_runtime",
      cause,
    );
  }
};

/** Smallest heap MiB or processor count. Zero is neither a heap size nor a count. */
export const JADX_JVM_NUMERIC_MINIMUM = 1;

/**
 * Omitted `REA_JADX_HEAP_MIB` and `REA_JADX_ACTIVE_PROCESSOR_COUNT` pass no
 * flag, so the JVM keeps its own default.
 */
export const JADX_JVM_DEFAULT = null;

/** Heap MiB must be an exact safe integer. A larger flag cannot round-trip. */
export const JADX_HEAP_MIB_MAXIMUM = Number.MAX_SAFE_INTEGER;

/** `-XX:ActiveProcessorCount` is a Java `int`; this is a count, not a duration. */
export const JADX_ACTIVE_PROCESSOR_COUNT_MAXIMUM = 2_147_483_647;

const jadxJvmBounds = (
  name: "REA_JADX_HEAP_MIB" | "REA_JADX_ACTIVE_PROCESSOR_COUNT",
) =>
  name === "REA_JADX_HEAP_MIB"
    ? {
        defaultValue: JADX_JVM_DEFAULT,
        minimum: JADX_JVM_NUMERIC_MINIMUM,
        maximum: JADX_HEAP_MIB_MAXIMUM,
      }
    : {
        defaultValue: JADX_JVM_DEFAULT,
        minimum: JADX_JVM_NUMERIC_MINIMUM,
        maximum: JADX_ACTIVE_PROCESSOR_COUNT_MAXIMUM,
      };

const resolveJvmArguments = (
  environment: Readonly<Record<string, string | undefined>>,
): readonly string[] => {
  const result: string[] = [];
  for (const [name, prefix, suffix] of [
    ["REA_JADX_HEAP_MIB", "-Xmx", "m"],
    ["REA_JADX_ACTIVE_PROCESSOR_COUNT", "-XX:ActiveProcessorCount=", ""],
  ] as const) {
    const bounds = jadxJvmBounds(name);
    const selected =
      environment[name] ??
      (bounds.defaultValue === null ? undefined : String(bounds.defaultValue));
    if (selected === undefined) continue;
    const parsed =
      /^[1-9]\d*$/u.test(selected) && Number.isSafeInteger(Number(selected))
        ? Number(selected)
        : undefined;
    if (parsed === undefined || parsed < bounds.minimum)
      throw configurationFailure(
        "open_options_invalid",
        `${name} must be a positive safe integer; received ${selected}.`,
        { setting: name, value: selected },
        "jvm_options",
      );
    if (parsed > bounds.maximum)
      throw configurationFailure(
        "open_options_invalid",
        name === "REA_JADX_ACTIVE_PROCESSOR_COUNT"
          ? `${name} exceeds the JVM's signed 32-bit processor-count range.`
          : `${name} must be a positive safe integer; received ${selected}.`,
        { setting: name, value: selected },
        "jvm_options",
      );
    result.push(`${prefix}${selected}${suffix}`);
  }
  return result;
};

const readOperationTimeout = (
  environment: Readonly<Record<string, string | undefined>>,
  runtimeTimeoutMs?: number,
): number => {
  if (runtimeTimeoutMs !== undefined) return runtimeTimeoutMs;
  const value = environment.REA_JADX_OPERATION_TIMEOUT_MS;
  if (value === undefined) return DEFAULT_JADX_OPERATION_TIMEOUT_MS;
  const parsed = providerStartupTimeoutSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw configurationFailure(
    "open_options_invalid",
    `REA_JADX_OPERATION_TIMEOUT_MS must be a decimal millisecond count from 1 to ${String(MAX_NODE_TIMER_DELAY_MS)}; received ${value}.`,
    { setting: "REA_JADX_OPERATION_TIMEOUT_MS", value },
    "operation_timeout",
  );
};

const inspectJavaRuntime = async (
  java: string,
  environment: Readonly<Record<string, string | undefined>>,
  options: JadxJavaProbeOptions,
): Promise<void> => {
  const result = await inspectJadxJava(java, environment, options);
  if (!result.ok) {
    const failure = result.error;
    throw configurationFailure(
      failure.code,
      failure.message,
      failure.diagnostics,
      failure.kind,
      failure.inspectionFailure,
    );
  }
};

const configurationFailure = (
  code: ConfigurationFailureCode,
  message: string,
  diagnostics: Readonly<Record<string, JsonValue>>,
  kind: JadxFailureKind,
  cause?: unknown,
): JadxConfigurationFailure =>
  new JadxConfigurationFailure(
    code,
    message,
    diagnostics,
    kind,
    cause === undefined ? undefined : { cause },
  );
