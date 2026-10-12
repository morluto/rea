import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { ConfigurationError } from "../domain/configurationErrors.js";
import { err, ok, type Result } from "../domain/result.js";

export const ANGR_MCP_CONFIG_SETTING = "REA_ANGR_MCP_CONFIG";
export const ANGR_PYTHON_SETTING = "REA_ANGR_PYTHON";

const common = {
  /** Headless sessions own the server process; attached sessions share one. */
  mode: z.enum(["attached", "headless"]).optional(),
  timeoutMs: z.number().int().positive().max(2_147_483_647).default(300_000),
  /** Deadline for the initial project load and CFG recovery. */
  startupTimeoutMs: z
    .number()
    .int()
    .positive()
    .max(2_147_483_647)
    .default(600_000),
  autoLoadLibs: z.boolean().default(false),
};
const registrationSchema = z
  .union([
    z
      .object({
        ...common,
        type: z.literal("stdio").optional(),
        command: z.string().min(1),
        args: z.array(z.string()).default([]),
        env: z.record(z.string(), z.string()).default({}),
      })
      .strict()
      .transform((config) => ({ ...config, mode: config.mode ?? "headless" })),
    z
      .object({
        ...common,
        type: z.literal("http").optional(),
        url: z.url().refine((value) => {
          const url = new URL(value);
          return (
            ["http:", "https:"].includes(url.protocol) &&
            ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
            url.username === "" &&
            url.password === ""
          );
        }, "angr MCP must use a local HTTP endpoint without URL credentials"),
        headers: z.record(z.string(), z.string()).default({}),
      })
      .strict()
      .transform((config) => ({ ...config, mode: config.mode ?? "attached" })),
  ])
  .refine(
    (config) => !("url" in config) || config.mode === "attached",
    "An HTTP angr MCP endpoint cannot be owned; use attached mode or a stdio command",
  );

/** An upstream angr MCP registration plus REA's lifecycle selection. */
export type AngrConfiguration = z.infer<typeof registrationSchema>;

/** Inputs that select one angr registration without reading the ambient environment. */
export interface AngrConfigurationSources {
  readonly mcpConfigPath?: string | undefined;
  readonly pythonPath?: string | undefined;
}

/** Read one explicit registration without starting or installing a provider. */
export const readAngrConfiguration = (
  sources: AngrConfigurationSources,
): Result<AngrConfiguration, ConfigurationError> => {
  if (sources.mcpConfigPath !== undefined)
    return readAngrRegistrationFile(sources.mcpConfigPath);
  if (sources.pythonPath !== undefined)
    return pythonRegistration(sources.pythonPath);
  return err(
    angrConfigurationError(
      `Set ${ANGR_PYTHON_SETTING} to a Python interpreter with angr installed, or ${ANGR_MCP_CONFIG_SETTING} to an angr MCP JSON registration; see docs/angr-provider.md.`,
    ),
  );
};

const pythonRegistration = (
  pythonPath: string,
): Result<AngrConfiguration, ConfigurationError> => {
  if (!isAbsolute(pythonPath))
    return err(
      angrConfigurationError(
        `${ANGR_PYTHON_SETTING} must be an absolute interpreter path.`,
        undefined,
        ANGR_PYTHON_SETTING,
      ),
    );
  try {
    if (!statSync(pythonPath).isFile())
      return err(
        angrConfigurationError(
          `${ANGR_PYTHON_SETTING} must name an interpreter file.`,
          undefined,
          ANGR_PYTHON_SETTING,
        ),
      );
  } catch (cause: unknown) {
    return err(
      angrConfigurationError(
        `${ANGR_PYTHON_SETTING} interpreter is missing or unreadable.`,
        cause,
        ANGR_PYTHON_SETTING,
      ),
    );
  }
  return ok(
    registrationSchema.parse({
      command: pythonPath,
      args: ["-m", "angr.mcp", "--transport", "stdio"],
      mode: "headless",
    }),
  );
};

const readAngrRegistrationFile = (
  path: string,
): Result<AngrConfiguration, ConfigurationError> => {
  try {
    if (statSync(path).size > 65_536)
      return err(
        angrConfigurationError(
          `${ANGR_MCP_CONFIG_SETTING} exceeds the 64 KiB registration size.`,
        ),
      );
    const input: unknown = JSON.parse(readFileSync(path, "utf8"));
    const envelope = z
      .object({ mcpServers: z.object({ angr: z.unknown() }) })
      .safeParse(input);
    const parsed = registrationSchema.safeParse(
      envelope.success ? envelope.data.mcpServers.angr : input,
    );
    return parsed.success
      ? ok(parsed.data)
      : err(
          angrConfigurationError(
            `${ANGR_MCP_CONFIG_SETTING} must contain an angr MCP command/args or local url registration; see docs/angr-provider.md.`,
            parsed.error,
          ),
        );
  } catch (cause: unknown) {
    return err(
      angrConfigurationError(
        `Cannot read angr MCP registration ${path}; provide a readable JSON configuration.`,
        cause,
      ),
    );
  }
};

/** A rejection that names the angr setting it concerns. */
export const angrConfigurationError = (
  constraint: string,
  cause?: unknown,
  setting: string = ANGR_MCP_CONFIG_SETTING,
): ConfigurationError =>
  new ConfigurationError(constraint, {
    ...(cause === undefined ? {} : { cause }),
    settings: [{ setting, constraint }],
  });
