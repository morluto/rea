import { z } from "zod";
import { isAbsolute } from "node:path";

import { ConfigurationError } from "../domain/errors.js";
import { err, ok, type Result } from "../domain/result.js";
import { analysisProviderSelectorSchema } from "../contracts/providerSelection.js";

export const environmentSchema = z
  .object({
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
    HOPPER_TARGET_KIND: z
      .enum(["executable", "database"])
      .default("executable"),
    HOPPER_LOADER_ARGS_JSON: z.string().optional(),
    REA_LOG_LEVEL: z
      .enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"])
      .default("info"),
    REA_PROCESS_CAPTURE_ENABLED: z.enum(["true", "false"]).default("false"),
    REA_PROCESS_CAPTURE_AUTO_GRANT: z.enum(["true", "false"]).default("true"),
    REA_ARTIFACT_NATIVE_MOUNT_ENABLED: z
      .enum(["true", "false"])
      .default("false"),
    REA_ARTIFACT_INTEGRITY_CONTINUE_ENABLED: z
      .enum(["true", "false"])
      .default("false"),
    REA_PROCESS_ALLOW_EXTERNAL_NETWORK: z
      .enum(["true", "false"])
      .default("false"),
    REA_PROCESS_EXECUTABLE_ROOTS_JSON: z.string().default("[]"),
    REA_PROCESS_WORKING_ROOTS_JSON: z.string().default("[]"),
    REA_PROCESS_ALLOWED_ENV_JSON: z.string().default("[]"),
    REA_EVIDENCE_ROOTS_JSON: z.string().default("[]"),
    REA_INVESTIGATION_INPUT_ROOTS_JSON: z.string().default("[]"),
    REA_ANALYSIS_SNAPSHOT_ROOTS_JSON: z.string().default("[]"),
    REA_REFERENCE_ROOTS_JSON: z.string().default("[]"),
    REA_REFERENCE_SECRET_PATTERNS_JSON: z.string().default("[]"),
    REA_BROWSER_OBSERVE_ENABLED: z.enum(["true", "false"]).default("false"),
    REA_BROWSER_CDP_ENDPOINTS_JSON: z.string().default("[]"),
    REA_BROWSER_ALLOWED_ORIGINS_JSON: z.string().default("[]"),
    REA_ELECTRON_OBSERVE_ENABLED: z.enum(["true", "false"]).default("false"),
    REA_ELECTRON_CDP_ENDPOINTS_JSON: z.string().default("[]"),
    REA_ELECTRON_FILE_ROOTS_JSON: z.string().default("[]"),
    REA_JAVASCRIPT_REPLAY_ENABLED: z.enum(["true", "false"]).default("false"),
    REA_JAVASCRIPT_REPLAY_ROOTS_JSON: z.string().default("[]"),
    REA_JAVASCRIPT_REPLAY_NODE_PATH: z
      .string()
      .min(1)
      .refine(isAbsolute, "REA_JAVASCRIPT_REPLAY_NODE_PATH must be absolute")
      .default(process.execPath),
    REA_JAVASCRIPT_REPLAY_BWRAP_PATH: z
      .string()
      .min(1)
      .refine(isAbsolute, "REA_JAVASCRIPT_REPLAY_BWRAP_PATH must be absolute")
      .default("/usr/bin/bwrap"),
    REA_JAVASCRIPT_REPLAY_SYSTEMD_RUN_PATH: z
      .string()
      .min(1)
      .refine(
        isAbsolute,
        "REA_JAVASCRIPT_REPLAY_SYSTEMD_RUN_PATH must be absolute",
      )
      .default("/usr/bin/systemd-run"),
    REA_JAVASCRIPT_REPLAY_SYSTEMCTL_PATH: z
      .string()
      .min(1)
      .refine(
        isAbsolute,
        "REA_JAVASCRIPT_REPLAY_SYSTEMCTL_PATH must be absolute",
      )
      .default("/usr/bin/systemctl"),
    REA_JAVASCRIPT_REPLAY_SHELL_PATH: z
      .string()
      .min(1)
      .refine(isAbsolute, "REA_JAVASCRIPT_REPLAY_SHELL_PATH must be absolute")
      .default("/usr/bin/bash"),
    REA_MANAGED_RUNTIME_ENABLED: z.enum(["true", "false"]).default("false"),
    REA_MANAGED_RUNTIME_ROOTS_JSON: z.string().default("[]"),
    REA_MANAGED_RUNTIME_EXECUTABLE_PATH: z
      .string()
      .min(1)
      .refine(
        isAbsolute,
        "REA_MANAGED_RUNTIME_EXECUTABLE_PATH must be absolute",
      )
      .default("/usr/bin/dotnet"),
    REA_PERMISSION_PROJECT_ROOT: z.string().min(1).optional(),
    REA_PERMISSION_PROJECT_STORE: z.string().min(1).optional(),
  })
  .refine(
    (value) =>
      (value.REA_PERMISSION_PROJECT_ROOT === undefined) ===
      (value.REA_PERMISSION_PROJECT_STORE === undefined),
    {
      message:
        "REA_PERMISSION_PROJECT_ROOT and REA_PERMISSION_PROJECT_STORE must be configured together",
    },
  );

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
