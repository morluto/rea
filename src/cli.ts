import { Cli, z } from "incur";
import { fileURLToPath } from "node:url";

import { runDoctor } from "./application/Doctor.js";
import { runDirectAnalysis } from "./application/DirectAnalysis.js";
import { runSetup } from "./application/Setup.js";
import { PRODUCT_IDENTITY } from "./identity.js";
import { createLogger, parseLogLevel, type Logger } from "./logger.js";

/**
 * Build the one-shot Incur CLI without starting Hopper at import time.
 * Analysis commands acquire and close their own sessions; bare `mcp` and
 * `--mcp` are intercepted by the executable dispatcher before this module loads.
 */
export const createCli = (): ReturnType<typeof Cli.create> => {
  const logger = createLogger(
    "cli",
    process.env.REA_LOG_LEVEL === undefined
      ? "silent"
      : parseLogLevel(process.env.REA_LOG_LEVEL),
  );
  const cli = Cli.create(PRODUCT_IDENTITY.cliBinary, {
    version: "0.1.0",
    description: "Reverse engineer apps from your terminal or coding agent.",
    mcp: {
      command: PRODUCT_IDENTITY.mcpCommand,
      instructions:
        "Ask which app and feature the user wants to understand, then open the app and investigate it.",
    },
    sync: {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      include: ["skills/*"],
      suggestions: [
        "understand how an app feature works",
        "decompile part of an app",
        "check my REA setup",
      ],
    },
  });

  cli.command("setup", {
    description: "Install requirements and configure coding agents",
    options: z.object({
      yes: z
        .boolean()
        .default(false)
        .describe("Approve prerequisite installation"),
    }),
    alias: { yes: "y" },
    run: ({ options }) =>
      logCliCommand(logger, "setup", () => runSetup(options.yes)),
  });
  cli.command("doctor", {
    description: "Check whether REA is ready",
    options: z.object({
      target: z.string().optional().describe("Optional app path to check"),
    }),
    run: ({ options }) =>
      logCliCommand(logger, "doctor", () => runDoctor(options.target)),
  });
  cli.command("analyze", {
    description: "Get an overview of an app",
    args: z.object({
      path: z.string().describe("App, program, or Hopper database path"),
    }),
    run: ({ args }) =>
      logCliCommand(logger, "analyze", () =>
        runDirectAnalysis(args.path, "binary_overview", {}, logger),
      ),
  });
  cli.command("decompile", {
    description: "Read one part of an app as code",
    args: z.object({
      path: z.string().describe("App or program path"),
      address: z.string().describe("Procedure address"),
    }),
    run: ({ args }) =>
      logCliCommand(logger, "decompile", () =>
        runDirectAnalysis(
          args.path,
          "procedure_pseudo_code",
          { procedure: args.address },
          logger,
        ),
      ),
  });
  return cli;
};

const logCliCommand = async <Value>(
  logger: Logger,
  command: string,
  execute: () => Promise<Value>,
): Promise<Value> => {
  const startedAt = performance.now();
  try {
    const value = await execute();
    logger.info(
      {
        command,
        durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
        status: "ok",
      },
      "CLI command completed",
    );
    return value;
  } catch (cause: unknown) {
    logger.error(
      {
        command,
        durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
        status: "error",
      },
      "CLI command failed",
    );
    throw cause;
  }
};
