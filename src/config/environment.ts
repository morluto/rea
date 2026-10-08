import { z } from "zod";
import { isAbsolute } from "node:path";

import { ConfigurationError } from "../domain/configurationErrors.js";
import { err, ok, type Result } from "../domain/result.js";
import { analysisProviderSelectorSchema } from "../contracts/providerSelection.js";
import { ghidraStartupTimeoutSchema } from "./ghidraStartupTimeout.js";
import { mcpResponseBudgetSchema } from "./mcpResponseBudget.js";

const environmentSchema = z.object({
  REA_ANALYSIS_PROVIDER: analysisProviderSelectorSchema.default("auto"),
  REA_MCP_MAX_RESPONSE_BYTES: mcpResponseBudgetSchema.optional(),
  REA_IDA_MCP_CONFIG: z
    .string()
    .min(1)
    .refine(isAbsolute, "REA_IDA_MCP_CONFIG must be absolute")
    .optional(),
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
  REA_GHIDRA_NATIVEAOT_JAR: z
    .string()
    .min(1)
    .refine(isAbsolute, "REA_GHIDRA_NATIVEAOT_JAR must be absolute")
    .optional(),
  REA_GHIDRA_STARTUP_TIMEOUT_MS: ghidraStartupTimeoutSchema,
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
