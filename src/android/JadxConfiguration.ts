import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, join } from "node:path";
import { AnalysisCapabilityUnavailableError } from "../domain/analysisErrorCore.js";
import type { AndroidOperation } from "../domain/androidAnalysis.js";

/** Caller-supplied tools, resolved only when an Android operation is selected. */
export interface JadxConfiguration {
  readonly jar: string;
  readonly java: string;
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
      `Android JADX subprocess ownership is unsupported on ${process.platform}; use Linux or macOS. Only Linux has real-provider verification.`,
    );
  const jar = environment.REA_JADX_MCP_JAR;
  if (environment.JAVA_HOME !== undefined && !isAbsolute(environment.JAVA_HOME))
    throw unavailable(
      "JAVA_HOME must select an existing JDK by absolute path; omit it to use java on PATH.",
    );
  if (jar === undefined || !isAbsolute(jar))
    throw unavailable(
      "Set REA_JADX_MCP_JAR to the absolute path of a caller-supplied jadx-headless-mcp 0.7.1 JAR. REA does not download or install it.",
    );
  try {
    await access(jar, constants.R_OK);
    if (!(await stat(jar)).isFile())
      throw unavailable(`REA_JADX_MCP_JAR is not a regular file: ${jar}`);
    return {
      jar: await realpath(jar),
      java:
        environment.JAVA_HOME === undefined
          ? "java"
          : join(environment.JAVA_HOME, "bin", "java"),
    };
  } catch (cause) {
    if (cause instanceof AnalysisCapabilityUnavailableError) throw cause;
    throw unavailable(
      `Cannot read REA_JADX_MCP_JAR ${jar}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
};
