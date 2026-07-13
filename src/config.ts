import { z } from "zod";

import { ConfigurationError } from "./domain/errors.js";
import { err, ok, type Result } from "./domain/result.js";
import type { LogLevel } from "./logger.js";
import type { ProcessExecutionPolicy } from "./domain/processCapture.js";
import type { EvidenceFilePolicy } from "./domain/evidenceBundle.js";
import type { ReferenceSourcePolicy } from "./domain/referenceSourcePolicy.js";

const DEFAULT_HOPPER_LAUNCHER_PATH =
  "/Applications/Hopper Disassembler.app/Contents/MacOS/hopper";
const defaultHopperLauncherPath = (): string =>
  process.platform === "linux"
    ? "/opt/hopper/bin/Hopper"
    : DEFAULT_HOPPER_LAUNCHER_PATH;

export interface AppConfig {
  readonly hopperLauncherPath: string;
  readonly hopperTargetPath: string | undefined;
  readonly hopperTargetKind: "executable" | "database";
  readonly hopperLoaderArgs: readonly string[];
  readonly logLevel: LogLevel;
  readonly processExecutionPolicy: ProcessExecutionPolicy;
  readonly artifactNativeMountEnabled: boolean;
  readonly evidenceFilePolicy: EvidenceFilePolicy;
  readonly referenceSourcePolicy: ReferenceSourcePolicy;
}

const environmentSchema = z.object({
  HOPPER_LAUNCHER_PATH: z.string().min(1).optional(),
  HOPPER_TARGET_PATH: z.string().min(1).optional(),
  HOPPER_TARGET_KIND: z.enum(["executable", "database"]).default("executable"),
  HOPPER_LOADER_ARGS_JSON: z.string().optional(),
  REA_LOG_LEVEL: z
    .enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"])
    .default("info"),
  REA_PROCESS_CAPTURE_ENABLED: z.enum(["true", "false"]).default("false"),
  REA_ARTIFACT_NATIVE_MOUNT_ENABLED: z.enum(["true", "false"]).default("false"),
  REA_PROCESS_ALLOW_EXTERNAL_NETWORK: z
    .enum(["true", "false"])
    .default("false"),
  REA_PROCESS_EXECUTABLE_ROOTS_JSON: z.string().default("[]"),
  REA_PROCESS_WORKING_ROOTS_JSON: z.string().default("[]"),
  REA_PROCESS_ALLOWED_ENV_JSON: z.string().default("[]"),
  REA_EVIDENCE_ROOTS_JSON: z.string().default("[]"),
  REA_REFERENCE_ROOTS_JSON: z.string().default("[]"),
  REA_REFERENCE_SECRET_PATTERNS_JSON: z.string().default("[]"),
});

const parseStringArray = (
  encoded: string,
  name: string,
): Result<readonly string[], ConfigurationError> => {
  try {
    const parsed = z
      .array(z.string().min(1))
      .max(128)
      .safeParse(JSON.parse(encoded));
    return parsed.success
      ? ok(parsed.data)
      : err(
          new ConfigurationError(`${name} must encode an array of strings`, {
            cause: parsed.error,
          }),
        );
  } catch (cause: unknown) {
    return err(new ConfigurationError(`${name} must be valid JSON`, { cause }));
  }
};

/**
 * Parse Hopper launcher configuration once at the composition root.
 * Explicit loader arguments override REA's header-derived defaults for a
 * supported target, allowing callers to refine Hopper's loader behavior without
 * bypassing REA's path and executable-header checks.
 */
export const parseConfig = (
  environment: Readonly<Record<string, string | undefined>>,
): Result<AppConfig, ConfigurationError> => {
  const parsedEnvironment = environmentSchema.safeParse(environment);
  if (!parsedEnvironment.success) {
    return err(
      new ConfigurationError("Invalid Hopper environment configuration", {
        cause: parsedEnvironment.error,
      }),
    );
  }
  let loaderArgs: unknown = [];
  const encoded = parsedEnvironment.data.HOPPER_LOADER_ARGS_JSON;
  if (encoded !== undefined) {
    try {
      loaderArgs = JSON.parse(encoded);
    } catch (cause: unknown) {
      return err(
        new ConfigurationError("HOPPER_LOADER_ARGS_JSON must be valid JSON", {
          cause,
        }),
      );
    }
  }
  const parsedArgs = z.array(z.string()).safeParse(loaderArgs);
  if (!parsedArgs.success) {
    return err(
      new ConfigurationError(
        "HOPPER_LOADER_ARGS_JSON must encode an array of strings",
        { cause: parsedArgs.error },
      ),
    );
  }
  const executableRoots = parseStringArray(
    parsedEnvironment.data.REA_PROCESS_EXECUTABLE_ROOTS_JSON,
    "REA_PROCESS_EXECUTABLE_ROOTS_JSON",
  );
  if (!executableRoots.ok) return executableRoots;
  const workingRoots = parseStringArray(
    parsedEnvironment.data.REA_PROCESS_WORKING_ROOTS_JSON,
    "REA_PROCESS_WORKING_ROOTS_JSON",
  );
  if (!workingRoots.ok) return workingRoots;
  const allowedEnvironment = parseStringArray(
    parsedEnvironment.data.REA_PROCESS_ALLOWED_ENV_JSON,
    "REA_PROCESS_ALLOWED_ENV_JSON",
  );
  if (!allowedEnvironment.ok) return allowedEnvironment;
  const evidenceRoots = parseStringArray(
    parsedEnvironment.data.REA_EVIDENCE_ROOTS_JSON,
    "REA_EVIDENCE_ROOTS_JSON",
  );
  if (!evidenceRoots.ok) return evidenceRoots;
  const referenceRoots = parseStringArray(
    parsedEnvironment.data.REA_REFERENCE_ROOTS_JSON,
    "REA_REFERENCE_ROOTS_JSON",
  );
  if (!referenceRoots.ok) return referenceRoots;
  const secretPatterns = parseStringArray(
    parsedEnvironment.data.REA_REFERENCE_SECRET_PATTERNS_JSON,
    "REA_REFERENCE_SECRET_PATTERNS_JSON",
  );
  if (!secretPatterns.ok) return secretPatterns;
  return ok({
    hopperLauncherPath:
      parsedEnvironment.data.HOPPER_LAUNCHER_PATH ??
      defaultHopperLauncherPath(),
    hopperTargetPath: parsedEnvironment.data.HOPPER_TARGET_PATH,
    hopperTargetKind: parsedEnvironment.data.HOPPER_TARGET_KIND,
    hopperLoaderArgs: parsedArgs.data,
    logLevel: parsedEnvironment.data.REA_LOG_LEVEL,
    processExecutionPolicy: {
      enabled: parsedEnvironment.data.REA_PROCESS_CAPTURE_ENABLED === "true",
      executableRoots: executableRoots.value,
      workingRoots: workingRoots.value,
      allowedEnvironment: allowedEnvironment.value,
      allowExternalNetwork:
        parsedEnvironment.data.REA_PROCESS_ALLOW_EXTERNAL_NETWORK === "true",
    },
    artifactNativeMountEnabled:
      parsedEnvironment.data.REA_ARTIFACT_NATIVE_MOUNT_ENABLED === "true",
    evidenceFilePolicy: {
      roots: evidenceRoots.value,
      maxBytes: 64 * 1024 * 1024,
      maxDepth: 64,
      maxStringLength: 1024 * 1024,
      maxNodes: 1_000_000,
    },
    referenceSourcePolicy: {
      roots: referenceRoots.value,
      secretPatterns: secretPatterns.value,
      maxBytes: 16 * 1024 * 1024,
      maxEntries: 10_000,
      maxDepth: 32,
      maxPathBytes: 4_096,
    },
  });
};
