#!/usr/bin/env node

import { snapshotEnvironment } from "./process/snapshotEnvironment.js";
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";

import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { parseConfig } from "./config.js";
import { createBinarySession } from "./composition/binary.js";
import { createLogger } from "./logger.js";
import { projectAnalysisError } from "./domain/analysisErrorProjection.js";
import type { RuntimeDependencies } from "./main/types.js";
import { SERVER_START_FAILED } from "./main/messages.js";
import { openInitialTarget } from "./main/startup.js";
import { startMcpTransport } from "./main/transport.js";
import {
  createOptionalObservationFactories,
  loadOptionalObservationProviders,
} from "./composition/optionalObservationProviders.js";
import { createToolResultDelivery } from "./server/toolResult.js";
import { createShutdown } from "./main/shutdown.js";

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
    return () => {
      process.off("SIGINT", handler);
      process.off("SIGTERM", handler);
      process.stdin.off("end", handler);
      process.stdin.off("close", handler);
    };
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
  const environment = snapshotEnvironment(dependencies.env);
  const config = parseConfig(environment);
  if (!config.ok) {
    dependencies.writeStderr(`${projectAnalysisError(config.error).message}\n`);
    return 1;
  }
  const logger = createLogger("mcp", config.value.logLevel);
  const serverLogger = logger.child({ layer: "server" });
  const session = createBinarySession(config.value, logger, environment);
  const opened = await openInitialTarget(
    session,
    config.value,
    serverLogger,
    dependencies.writeStderr,
  );
  if (!opened.ok) return opened.exitCode;
  const transport = await startMcpTransport(dependencies, session, {
    logger,
    serverLogger,
    environment,
    delivery: createToolResultDelivery(config.value.mcpMaxResponseBytes),
    loadOptionalProviders:
      dependencies.loadOptionalProviders ??
      (() =>
        loadOptionalObservationProviders(
          createOptionalObservationFactories(environment),
        )),
  });
  if (!transport.ok) return 1;
  createShutdown({
    handle: transport.handle,
    closeAndroid: transport.closeAndroid,
    session,
    dependencies,
    serverLogger,
  });
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
  } catch (cause: unknown) {
    // Intentionally redact the startup cause from caller-visible output;
    // unexpected failures must not leak internal details.
    void cause;
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
