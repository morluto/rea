import { z } from "zod";
import { isAbsolute } from "node:path";
import { defaultJavaScriptReplayConfiguration } from "./runtimeConfiguration.js";

import { ConfigurationError } from "../domain/errors.js";
import { err, ok, type Result } from "../domain/result.js";
import { analysisProviderSelectorSchema } from "../contracts/providerSelection.js";

const environmentSchema = z.object({
  REA_ANALYSIS_PROVIDER: analysisProviderSelectorSchema.default("auto"),
  GHIDRA_INSTALL_DIR: z
    .string()
    .min(1)
    .refine(isAbsolute, "GHIDRA_INSTALL_DIR must be absolute")
    .optional(),
  JAVA_HOME: z
    .string()
    .min(1)
    .refine(isAbsolute, "JAVA_HOME must be absolute")
    .optional(),
  REA_ILSPY_CMD_PATH: z
    .string()
    .min(1)
    .refine(isAbsolute, "REA_ILSPY_CMD_PATH must be absolute")
    .optional(),
  HOPPER_LAUNCHER_PATH: z.string().min(1).optional(),
  HOPPER_TARGET_PATH: z.string().min(1).optional(),
  HOPPER_TARGET_KIND: z.enum(["executable", "database"]).default("executable"),
  HOPPER_LOADER_ARGS_JSON: z.string().optional(),
  REA_LOG_LEVEL: z
    .enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"])
    .default("info"),
  REA_REFERENCE_SECRET_PATTERNS_JSON: z.string().default("[]"),
  REA_JAVASCRIPT_REPLAY_NODE_PATH: z
    .string()
    .min(1)
    .refine(isAbsolute, "REA_JAVASCRIPT_REPLAY_NODE_PATH must be absolute")
    .default(() => defaultJavaScriptReplayConfiguration().nodePath),
  REA_JAVASCRIPT_REPLAY_BWRAP_PATH: z
    .string()
    .min(1)
    .refine(isAbsolute, "REA_JAVASCRIPT_REPLAY_BWRAP_PATH must be absolute")
    .default(() => defaultJavaScriptReplayConfiguration().bubblewrapPath),
  REA_JAVASCRIPT_REPLAY_SYSTEMD_RUN_PATH: z
    .string()
    .min(1)
    .refine(
      isAbsolute,
      "REA_JAVASCRIPT_REPLAY_SYSTEMD_RUN_PATH must be absolute",
    )
    .default(() => defaultJavaScriptReplayConfiguration().systemdRunPath),
  REA_JAVASCRIPT_REPLAY_SYSTEMCTL_PATH: z
    .string()
    .min(1)
    .refine(isAbsolute, "REA_JAVASCRIPT_REPLAY_SYSTEMCTL_PATH must be absolute")
    .default(() => defaultJavaScriptReplayConfiguration().systemctlPath),
  REA_JAVASCRIPT_REPLAY_SHELL_PATH: z
    .string()
    .min(1)
    .refine(isAbsolute, "REA_JAVASCRIPT_REPLAY_SHELL_PATH must be absolute")
    .default(() => defaultJavaScriptReplayConfiguration().shellPath),
  REA_MANAGED_RUNTIME_EXECUTABLE_PATH: z
    .string()
    .min(1)
    .refine(isAbsolute, "REA_MANAGED_RUNTIME_EXECUTABLE_PATH must be absolute")
    .optional(),
});

export type Environment = z.infer<typeof environmentSchema>;

export const parseEnvironment = (
  environment: Readonly<Record<string, string | undefined>>,
): Result<Environment, ConfigurationError> => {
  const parsed = environmentSchema.safeParse(environment);
  if (!parsed.success) {
    return err(
      new ConfigurationError("Invalid REA environment configuration", {
        cause: parsed.error,
      }),
    );
  }
  return ok(parsed.data);
};
