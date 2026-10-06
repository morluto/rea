import { z } from "zod";
import { isAbsolute } from "node:path";

import { ConfigurationError } from "../domain/configurationErrors.js";
import { err, ok, type Result } from "../domain/result.js";
import { analysisProviderSelectorSchema } from "../contracts/providerSelection.js";

const environmentSchema = z.object({
  REA_BINARY_NINJA_MCP_URL: z
    .url()
    .refine((value) => {
      const url = new URL(value);
      return (
        ["http:", "https:"].includes(url.protocol) &&
        ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
        url.username === "" &&
        url.password === "" &&
        url.search === "" &&
        url.hash === ""
      );
    }, "Binary Ninja MCP must use a loopback HTTP URL without credentials, query, or fragment")
    .optional(),
  REA_BINARY_NINJA_MCP_COMMAND: z
    .string()
    .min(1)
    .refine(isAbsolute, "Binary Ninja MCP command must be absolute")
    .optional(),
  REA_BINARY_NINJA_MCP_ARGS_JSON: z.string().default("[]"),
  REA_BINARY_NINJA_MCP_TOKEN: z.string().min(1).optional(),
  REA_BINARY_NINJA_MCP_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .max(2_147_483_647)
    .default(300_000),
  REA_ANALYSIS_PROVIDER: analysisProviderSelectorSchema.default("auto"),
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
