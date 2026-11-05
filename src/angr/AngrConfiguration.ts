import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";
import type { RetainedResourceScope } from "../application/AnalysisProvider.js";
import { AnalysisCleanupLease } from "../artifacts/AnalysisCleanupLease.js";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import { ConfigurationError } from "../domain/configurationErrors.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  regularFileCancellation,
  RegularFileCleanupFailure,
  withOwnedRegularFile,
} from "../filesystem/OwnedRegularFile.js";
import {
  NonRegularFileReadError,
  RegularFileOperationCancelled,
} from "../filesystem/RegularFile.js";
import { readBoundedFileBytes } from "../process/BoundedFileBytes.js";

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
  /** Session-wide decompilation flavor applied after load; requires an angr with flavor tools. */
  flavor: z.string().min(1).optional(),
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

/**
 * Longest single REA request against angr: a first request runs load_binary
 * and get_cfg, each bounded by startupTimeoutMs, before the request itself.
 */
export const angrRequestBudgetMs = (config: AngrConfiguration): number =>
  2 * config.startupTimeoutMs + config.timeoutMs;

/** Owner and cancellation for reading a registration file. */
export interface AngrConfigurationReadOptions {
  readonly signal?: AbortSignal | undefined;
  readonly resourceScope: RetainedResourceScope;
}

/** Read one explicit registration without starting or installing a provider. */
export const readAngrConfiguration = async (
  sources: AngrConfigurationSources,
  options: AngrConfigurationReadOptions,
): Promise<Result<AngrConfiguration, ConfigurationError>> => {
  if (sources.mcpConfigPath !== undefined)
    return readAngrRegistrationFile(sources.mcpConfigPath, options);
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

const MAXIMUM_REGISTRATION_BYTES = 65_536;

const registrationTooLarge = (): ConfigurationError =>
  angrConfigurationError(
    `${ANGR_MCP_CONFIG_SETTING} exceeds the 64 KiB registration size.`,
  );

const cleanupReason = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const parseRegistration = (
  text: string,
): Result<AngrConfiguration, ConfigurationError> => {
  const input: unknown = JSON.parse(text);
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
};

/**
 * Open without blocking and require a regular file, so a FIFO, socket or
 * device cannot stall discovery while it waits for a producer.
 */
const readAngrRegistrationFile = (
  path: string,
  options: AngrConfigurationReadOptions,
): Promise<Result<AngrConfiguration, ConfigurationError>> =>
  options.resourceScope.run(async () => {
    let closeLease: AnalysisCleanupLease | undefined;
    const notRegular = (cause: unknown) =>
      angrConfigurationError(
        `${ANGR_MCP_CONFIG_SETTING} must select a regular JSON file: ${path}`,
        cause,
      );
    const unreadable = (cause: unknown) =>
      angrConfigurationError(
        `Cannot read angr MCP registration ${path}; provide a readable JSON configuration.`,
        cause,
      );
    try {
      const text = await withOwnedRegularFile<string>(
        path,
        {
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          retainFailedClose: (owner) => {
            const lease = AnalysisCleanupLease.forCloseOwner(owner, path);
            closeLease = lease;
            options.resourceScope.retain(
              {
                close: () => lease.release(),
                get cleanupResources() {
                  return lease.cleanupResources;
                },
              },
              path,
            );
          },
        },
        async ({ handle, initial }) => {
          if (initial.size > MAXIMUM_REGISTRATION_BYTES)
            throw registrationTooLarge();
          const bytes = await readBoundedFileBytes(
            handle,
            MAXIMUM_REGISTRATION_BYTES,
            {
              signal: options.signal,
              cancellationFailure: (reason) =>
                new RegularFileOperationCancelled(reason),
            },
          );
          if (bytes === undefined) throw registrationTooLarge();
          return bytes.toString("utf8");
        },
      );
      try {
        return parseRegistration(text);
      } catch (cause: unknown) {
        return err(unreadable(cause));
      }
    } catch (cause: unknown) {
      if (cause instanceof ConfigurationError) return err(cause);
      if (cause instanceof NonRegularFileReadError)
        return err(notRegular(cause));
      if (cause instanceof AnalysisCancelledError) throw cause;
      const cancellation = regularFileCancellation(cause);
      if (cancellation !== undefined) {
        const error = new AnalysisCancelledError("angr:registration", {
          cause: cancellation.reason,
          ...(cause instanceof RegularFileCleanupFailure
            ? {
                cleanup: {
                  reason: cleanupReason(cause.cleanupCause),
                  resources: [path],
                },
              }
            : {}),
        });
        if (cause instanceof RegularFileCleanupFailure)
          closeLease?.bindCleanupError(error);
        throw error;
      }
      if (cause instanceof RegularFileCleanupFailure) {
        const primary =
          cause.outcome.kind === "failed" ? cause.outcome.cause : undefined;
        const base =
          primary instanceof ConfigurationError
            ? primary
            : primary instanceof NonRegularFileReadError
              ? notRegular(primary)
              : primary !== undefined
                ? unreadable(primary)
                : undefined;
        const constraint = `Close remains incomplete for ${path}`;
        const error = new ConfigurationError(
          base?.message ??
            `Cannot close angr MCP registration ${path}; provide a readable JSON configuration.`,
          {
            cause,
            cleanup: {
              reason: cleanupReason(cause.cleanupCause),
              resources: [path],
            },
            settings: [{ setting: ANGR_MCP_CONFIG_SETTING, constraint }],
          },
        );
        closeLease?.bindCleanupError(error);
        return err(error);
      }
      return err(unreadable(cause));
    }
  });

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
