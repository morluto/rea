import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { AnalysisCapabilityUnavailableError } from "../domain/analysisErrorCore.js";
import type { AndroidOperation } from "../domain/android/androidAnalysis.js";
import type { JsonValue } from "../domain/jsonValue.js";
import type { ProviderAvailability } from "../application/AnalysisProvider.js";
import { ZipArtifactReader } from "../artifacts/ZipArtifactReader.js";
import {
  execFileOutput,
  execFileOutputFailure,
} from "../process/ExecFileOutput.js";
import { JADX_JAR_CONFIGURATION_REMEDIATION } from "./JadxRelease.js";

const JAVA_MODULE_LISTING_TIMEOUT_MS = 10_000;
const JAVA_MODULE_LISTING_MAX_OUTPUT_BYTES = 1024 * 1024;
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
  | "unsupported_host"
  | "unsupported_version"
  | "version_unresolved"
  | "open_options_invalid";

class JadxConfigurationFailure extends Error {
  constructor(
    readonly code: ConfigurationFailureCode,
    message: string,
    readonly diagnostics: Readonly<Record<string, JsonValue>>,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/** Inspect the same JAR and Java prerequisites that gate actual execution. */
export const inspectJadxAvailability = async (
  environment: Readonly<Record<string, string | undefined>>,
  signal?: AbortSignal,
): Promise<ProviderAvailability> => {
  try {
    const configuration = await readJadxConfiguration(environment, signal);
    return {
      status: "available",
      code: null,
      reason: null,
      diagnostics: {
        configured: true,
        java_executable: configuration.java,
        jdk_compiler: true,
        jar_path: configuration.jar,
      },
    };
  } catch (cause) {
    if (signal?.aborted === true) throw cause;
    if (cause instanceof JadxConfigurationFailure)
      return {
        status: "unavailable",
        code: cause.code,
        reason: cause.message,
        diagnostics: cause.diagnostics,
      };
    throw cause;
  }
};

/** Resolve caller-selected tools and preserve the same prerequisite diagnostics. */
export const resolveJadxConfiguration = async (
  environment: Readonly<Record<string, string | undefined>>,
  operation: AndroidOperation,
  signal?: AbortSignal,
): Promise<JadxConfiguration> => {
  try {
    return await readJadxConfiguration(environment, signal);
  } catch (cause) {
    if (signal?.aborted === true) throw cause;
    if (!(cause instanceof JadxConfigurationFailure)) throw cause;
    const output = cause.diagnostics;
    throw new AnalysisCapabilityUnavailableError(
      "jadx",
      operation,
      cause.message,
      {
        cause,
        userMessage: cause.message,
        ...(typeof output.stdout === "string" &&
        typeof output.stderr === "string"
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
  }
};

const readJadxConfiguration = async (
  environment: Readonly<Record<string, string | undefined>>,
  signal?: AbortSignal,
): Promise<JadxConfiguration> => {
  requireSupportedHost();
  const jar = await resolveJar(environment);
  const java = resolveJava(environment);
  await requireJavaHomeExecutable(environment.JAVA_HOME, java);
  const jvmArguments = resolveJvmArguments(environment);
  await inspectJavaRuntime(java, environment, signal);
  await requireEngineArchive(jar, signal);
  return { jar, java, jvmArguments };
};

const requireEngineArchive = async (
  jar: string,
  signal?: AbortSignal,
): Promise<void> => {
  // These classes are consumed directly by ReaJadxBridge.java. This checks the
  // classpath inventory without loading engine code or starting a JADX session.
  const missing = new Set([
    "com/atxx/jhmcp/JadxSession.class",
    "com/atxx/jhmcp/SessionHolder.class",
    "jadx/api/JadxDecompiler.class",
    "com/google/gson/Gson.class",
    "io/modelcontextprotocol/kotlin/sdk/server/Server.class",
  ]);
  const reader = new ZipArtifactReader(jar, "zip", JAR_METADATA_READ_MAX_BYTES);
  try {
    for await (const entry of reader.entries(signal)) {
      if (entry.kind === "file" && !entry.encrypted) missing.delete(entry.path);
      if (missing.size === 0) return;
    }
  } catch (cause) {
    if (signal?.aborted === true) throw cause;
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw configurationFailure(
      "version_unresolved",
      `Cannot inspect REA_JADX_MCP_JAR ${jar} as a Java archive: ${reason}. ${JADX_JAR_CONFIGURATION_REMEDIATION}`,
      {
        jar_path: jar,
        phase: "jar-inspection",
        archive_error: reason,
        maximum_metadata_read_bytes: JAR_METADATA_READ_MAX_BYTES,
      },
      cause,
    );
  } finally {
    await reader.close();
  }
  throw configurationFailure(
    "unsupported_version",
    `REA_JADX_MCP_JAR ${jar} does not contain the required metadata bridge classes: ${[...missing].join(", ")}. ${JADX_JAR_CONFIGURATION_REMEDIATION}`,
    { jar_path: jar, phase: "jar-inspection", missing_classes: [...missing] },
  );
};

const requireSupportedHost = (): void => {
  if (process.platform === "linux" || process.platform === "darwin") return;
  throw configurationFailure(
    "unsupported_host",
    `Android JADX subprocess ownership is unsupported on ${process.platform}; use Linux or macOS. The metadata bridge has real-provider verification on macOS arm64.`,
    { platform: process.platform },
  );
};

const resolveJar = async (
  environment: Readonly<Record<string, string | undefined>>,
): Promise<string> => {
  const jar = environment.REA_JADX_MCP_JAR;
  if (jar === undefined || !isAbsolute(jar))
    throw configurationFailure(
      "not_configured",
      JADX_JAR_CONFIGURATION_REMEDIATION,
      { jar_configured: false },
    );
  try {
    await access(jar, constants.R_OK);
    if (!(await stat(jar)).isFile())
      throw configurationFailure(
        "executable_missing",
        `REA_JADX_MCP_JAR is not a regular file: ${jar}`,
        { jar_path: jar },
      );
    return await realpath(jar);
  } catch (cause) {
    if (cause instanceof JadxConfigurationFailure) throw cause;
    throw configurationFailure(
      "executable_missing",
      `Cannot read REA_JADX_MCP_JAR ${jar}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { jar_path: jar },
      cause,
    );
  }
};

const resolveJava = (
  environment: Readonly<Record<string, string | undefined>>,
): string => {
  if (environment.JAVA_HOME === undefined) return "java";
  if (isAbsolute(environment.JAVA_HOME))
    return join(environment.JAVA_HOME, "bin", "java");
  throw configurationFailure(
    "open_options_invalid",
    "JAVA_HOME must select an existing JDK by absolute path; omit it to use java on PATH.",
    { java_home: environment.JAVA_HOME },
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
    );
  } catch (cause) {
    if (cause instanceof JadxConfigurationFailure) throw cause;
    throw configurationFailure(
      "runtime_missing",
      `Cannot execute JAVA_HOME java ${java}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { java_executable: java },
      cause,
    );
  }
};

const resolveJvmArguments = (
  environment: Readonly<Record<string, string | undefined>>,
): readonly string[] => {
  const result: string[] = [];
  for (const [name, prefix, suffix] of [
    ["REA_JADX_HEAP_MIB", "-Xmx", "m"],
    ["REA_JADX_ACTIVE_PROCESSOR_COUNT", "-XX:ActiveProcessorCount=", ""],
  ] as const) {
    const value = environment[name];
    if (value === undefined) continue;
    if (!/^[1-9]\d*$/u.test(value) || !Number.isSafeInteger(Number(value)))
      throw configurationFailure(
        "open_options_invalid",
        `${name} must be a positive safe integer; received ${value}.`,
        { setting: name, value },
      );
    if (
      name === "REA_JADX_ACTIVE_PROCESSOR_COUNT" &&
      Number(value) > 2_147_483_647
    )
      throw configurationFailure(
        "open_options_invalid",
        `${name} exceeds the JVM's signed 32-bit processor-count range.`,
        { setting: name, value },
      );
    result.push(`${prefix}${value}${suffix}`);
  }
  return result;
};

const inspectJavaRuntime = async (
  java: string,
  environment: Readonly<Record<string, string | undefined>>,
  signal?: AbortSignal,
): Promise<void> => {
  let stdout: string;
  let stderr: string;
  try {
    ({ stdout, stderr } = await execFileOutput(java, ["--list-modules"], {
      env: { ...environment },
      timeout: JAVA_MODULE_LISTING_TIMEOUT_MS,
      maxBuffer: JAVA_MODULE_LISTING_MAX_OUTPUT_BYTES,
      ...(signal === undefined ? {} : { signal }),
    }));
  } catch (cause) {
    if (signal?.aborted === true) throw cause;
    const output = execFileOutputFailure(cause);
    if (output === undefined) throw cause;
    const diagnostics = {
      java_executable: java,
      phase: "module-inspection",
      exit_code: typeof output.code === "number" ? output.code : null,
      process_error_code: typeof output.code === "string" ? output.code : null,
      signal: output.signal,
      killed: output.killed,
      stdout: output.stdout,
      stderr: output.stderr,
      output_truncated: output.outputTruncated,
    } satisfies Readonly<Record<string, JsonValue>>;
    if (output.outputTruncated)
      throw configurationFailure(
        "version_unresolved",
        `The selected Java launcher ${java} exceeded the ${JAVA_MODULE_LISTING_MAX_OUTPUT_BYTES / (1024 * 1024)} MiB output budget while listing modules. REA retained partial output but could not establish compiler or version availability. Inspect the selected launcher for verbose or unbounded output; ` +
          "java --list-modules should return a concise module listing.",
        {
          ...diagnostics,
          failure: "output_limit",
          output_limit_bytes: JAVA_MODULE_LISTING_MAX_OUTPUT_BYTES,
        },
        cause,
      );
    if (output.killed)
      throw configurationFailure(
        "version_unresolved",
        `The selected Java launcher ${java} was terminated or did not finish the module-listing probe within ${JAVA_MODULE_LISTING_TIMEOUT_MS / 1000} seconds. Inspect the launcher and its startup responsiveness, then verify it returns compiler and version modules with java --list-modules.`,
        {
          ...diagnostics,
          failure: "probe_terminated",
          deadline_ms: JAVA_MODULE_LISTING_TIMEOUT_MS,
        },
        cause,
      );
    throw configurationFailure(
      "runtime_missing",
      `Cannot inspect selected Java runtime ${java}: ${output.stderr.trim() || errorText(cause)}. Select a full JDK including jdk.compiler via JAVA_HOME or PATH; verify it with java --list-modules.`,
      diagnostics,
      cause,
    );
  }
  const compiler = /^jdk\.compiler(?:@|$)/mu.test(stdout);
  if (!compiler)
    throw configurationFailure(
      "runtime_missing",
      `Selected Java runtime ${java} does not provide jdk.compiler. Select a full JDK including jdk.compiler via JAVA_HOME or PATH; verify it with java --list-modules. A JRE cannot compile REA's source bridge.`,
      {
        java_executable: java,
        phase: "module-inspection",
        jdk_compiler: false,
        stdout,
        stderr,
        output_truncated: false,
      },
    );
  const major = /^java\.base@(\d+)(?:[.+_-]|$)/mu.exec(stdout)?.[1];
  if (major === undefined)
    throw configurationFailure(
      "version_unresolved",
      `The selected Java launcher ${java} did not report a parseable java.base version in its module listing. Inspect the launcher output and verify it with java --list-modules.`,
      {
        java_executable: java,
        phase: "module-inspection",
        jdk_compiler: true,
        java_major: null,
        stdout,
        stderr,
        output_truncated: false,
      },
    );
  if (Number(major) < 17)
    throw configurationFailure(
      "unsupported_version",
      `Selected Java runtime ${java} must be JDK 17 or newer and include jdk.compiler; verify it with java --list-modules.`,
      {
        java_executable: java,
        phase: "module-inspection",
        jdk_compiler: true,
        java_major: major ?? null,
        stdout,
        stderr,
        output_truncated: false,
      },
    );
};

const configurationFailure = (
  code: ConfigurationFailureCode,
  message: string,
  diagnostics: Readonly<Record<string, JsonValue>>,
  cause?: unknown,
): JadxConfigurationFailure =>
  new JadxConfigurationFailure(
    code,
    message,
    diagnostics,
    cause === undefined ? undefined : { cause },
  );

const errorText = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);
