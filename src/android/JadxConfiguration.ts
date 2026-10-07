import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, join } from "node:path";
import { AnalysisCapabilityUnavailableError } from "../domain/analysisErrorCore.js";
import type { AndroidOperation } from "../domain/android/androidAnalysis.js";
import { JADX_JAR_CONFIGURATION_REMEDIATION } from "./JadxRelease.js";

/** Caller-supplied tools, resolved only when an Android operation is selected. */
export interface JadxConfiguration {
  readonly jar: string;
  readonly java: string;
  readonly jvmArguments: readonly string[];
}

/** Admit explicit local tooling without installing or changing host configuration. */
export const resolveJadxConfiguration = async (
  environment: Readonly<Record<string, string | undefined>>,
  operation: AndroidOperation,
): Promise<JadxConfiguration> => {
  const unavailable = (reason: string) =>
    new AnalysisCapabilityUnavailableError("jadx", operation, reason);
  if (process.platform !== "linux" && process.platform !== "darwin")
    throw unavailable(
      `Android JADX subprocess ownership is unsupported on ${process.platform}; use Linux or macOS. The metadata bridge has real-provider verification on macOS arm64.`,
    );
  const jar = environment.REA_JADX_MCP_JAR;
  if (environment.JAVA_HOME !== undefined && !isAbsolute(environment.JAVA_HOME))
    throw unavailable(
      "JAVA_HOME must select an existing JDK by absolute path; omit it to use java on PATH.",
    );
  if (jar === undefined || !isAbsolute(jar))
    throw unavailable(JADX_JAR_CONFIGURATION_REMEDIATION);
  const java =
    environment.JAVA_HOME === undefined
      ? "java"
      : join(environment.JAVA_HOME, "bin", "java");
  try {
    await access(jar, constants.R_OK);
    if (!(await stat(jar)).isFile())
      throw unavailable(`REA_JADX_MCP_JAR is not a regular file: ${jar}`);
  } catch (cause) {
    if (cause instanceof AnalysisCapabilityUnavailableError) throw cause;
    throw unavailable(
      `Cannot read REA_JADX_MCP_JAR ${jar}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  if (environment.JAVA_HOME !== undefined) {
    try {
      await access(java, constants.R_OK | constants.X_OK);
      if (!(await stat(java)).isFile())
        throw unavailable(`JAVA_HOME java is not a regular file: ${java}`);
    } catch (cause) {
      if (cause instanceof AnalysisCapabilityUnavailableError) throw cause;
      throw unavailable(
        `Cannot execute JAVA_HOME java ${java}: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }
  const jvmArguments: string[] = [];
  for (const [name, prefix, suffix] of [
    ["REA_JADX_HEAP_MIB", "-Xmx", "m"],
    ["REA_JADX_ACTIVE_PROCESSOR_COUNT", "-XX:ActiveProcessorCount=", ""],
  ] as const) {
    const value = environment[name];
    if (value === undefined) continue;
    if (!/^[1-9]\d*$/u.test(value) || !Number.isSafeInteger(Number(value)))
      throw unavailable(
        `${name} must be a positive safe integer; received ${value}.`,
      );
    if (
      name === "REA_JADX_ACTIVE_PROCESSOR_COUNT" &&
      Number(value) > 2_147_483_647
    )
      throw unavailable(
        `${name} exceeds the JVM's signed 32-bit processor-count range.`,
      );
    jvmArguments.push(`${prefix}${value}${suffix}`);
  }
  return { jar: await realpath(jar), java, jvmArguments };
};
