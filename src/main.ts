#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";

import {
  serveStdio,
  type StdioServerHandle,
} from "@modelcontextprotocol/server/stdio";

import { parseConfig } from "./config.js";
import { createBinarySession } from "./application/runtime.js";
import { createServer } from "./server/createServer.js";
import { createLogger } from "./logger.js";
import { projectAnalysisError } from "./domain/errors.js";

const MCP_CONNECTION_LOST =
  "REA lost its MCP client connection. Restart REA from your MCP client.";
const MCP_CONNECTION_START_FAILED =
  "REA could not start its MCP connection. Restart REA from your MCP client; run `rea doctor` if it fails again.";
const MCP_SHUTDOWN_FAILED =
  "REA could not close cleanly. End the REA process before starting it again.";
const SERVER_START_FAILED =
  "REA could not start. Run `rea doctor`, then restart REA from your MCP client.";

/** Process boundaries owned by the MCP executable adapter. */
interface RuntimeDependencies {
  readonly env: NodeJS.ProcessEnv;
  readonly serve: typeof serveStdio;
  readonly writeStderr: (text: string) => void;
  readonly setExitCode: (code: number) => void;
  readonly registerShutdown: (handler: () => void) => void;
}

const runtimeDependencies = (): RuntimeDependencies => ({
  env: process.env,
  serve: serveStdio,
  writeStderr: (text) => process.stderr.write(text),
  setExitCode: (code) => {
    process.exitCode = code;
  },
  registerShutdown: (handler) => {
    process.once("SIGINT", handler);
    process.once("SIGTERM", handler);
    process.stdin.once("end", handler);
    process.stdin.once("close", handler);
  },
});

/**
 * Start the long-lived MCP adapter and install idempotent shutdown handlers.
 * The adapter owns its BinarySession for the process lifetime; EOF and process
 * signals close bridge resources without assuming ownership of the Hopper app.
 */
export const run = async (
  dependencies: RuntimeDependencies = runtimeDependencies(),
): Promise<number> => {
  const config = parseConfig(dependencies.env);
  if (!config.ok) {
    dependencies.writeStderr(`${projectAnalysisError(config.error).message}\n`);
    return 1;
  }
  const logger = createLogger("mcp", config.value.logLevel);
  const serverLogger = logger.child({ layer: "server" });

  const session = createBinarySession(config.value, logger);
  if (config.value.hopperTargetPath !== undefined) {
    const opened = await session.open(config.value.hopperTargetPath, {
      targetKind: config.value.hopperTargetKind,
    });
    if (!opened.ok) {
      await session.close();
      serverLogger.error(
        { errorTag: opened.error._tag },
        "Initial target failed to open",
      );
      dependencies.writeStderr(
        `${projectAnalysisError(opened.error).message}\n`,
      );
      return 1;
    }
  }
  let handle: StdioServerHandle;
  try {
    handle = dependencies.serve(
      () =>
        createServer(session, session, {
          logger,
          processPolicy: config.value.processExecutionPolicy,
          evidenceFilePolicy: config.value.evidenceFilePolicy,
          analysisSnapshotFilePolicy: config.value.analysisSnapshotFilePolicy,
        }),
      {
        onerror: () => {
          serverLogger.error(MCP_CONNECTION_LOST);
          dependencies.writeStderr(`${MCP_CONNECTION_LOST}\n`);
        },
      },
    );
  } catch {
    await session.close();
    serverLogger.error(MCP_CONNECTION_START_FAILED);
    dependencies.writeStderr(`${MCP_CONNECTION_START_FAILED}\n`);
    return 1;
  }

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    shutdownPromise ??= (async () => {
      await handle.close();
      await session.close();
    })();
    return shutdownPromise;
  };
  const requestShutdown = (): void => {
    shutdown().catch(() => {
      dependencies.setExitCode(1);
      serverLogger.error(MCP_SHUTDOWN_FAILED);
      dependencies.writeStderr(`${MCP_SHUTDOWN_FAILED}\n`);
    });
  };

  dependencies.registerShutdown(requestShutdown);
  return 0;
};

/** Run the executable boundary without exposing an unexpected startup cause. */
export const runEntrypoint = async (
  start: () => Promise<number> = () => run(),
  writeStderr: (text: string) => void = (text) => process.stderr.write(text),
  setExitCode: (code: number) => void = (code) => {
    process.exitCode = code;
  },
): Promise<void> => {
  try {
    setExitCode(await start());
  } catch {
    writeStderr(`${SERVER_START_FAILED}\n`);
    setExitCode(1);
  }
};

const entryPath = process.argv[1];
if (
  entryPath !== undefined &&
  pathToFileURL(realpathSync(entryPath)).href === import.meta.url
) {
  void runEntrypoint();
}
