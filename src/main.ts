#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";

import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { parseConfig } from "./config.js";
import { createBinarySession } from "./application/runtime.js";
import { createLogger } from "./logger.js";
import { projectAnalysisError } from "./domain/errors.js";
import { loadConfiguredPermissionAuthority } from "./application/PermissionConfiguration.js";
import { CdpBrowserProvider } from "./browser/CdpBrowserProvider.js";
import { CdpElectronProvider } from "./browser/CdpElectronProvider.js";
import type { RuntimeDependencies } from "./main/types.js";
import { SERVER_START_FAILED } from "./main/messages.js";
import { createRuntimeState } from "./main/state.js";
import { openInitialTarget } from "./main/startup.js";
import { startMcpTransport } from "./main/transport.js";
import { registerConfigReload } from "./main/reload.js";
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
  registerReload: (handler) => {
    process.on("SIGHUP", handler);
    return () => process.off("SIGHUP", handler);
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
  const permissionAuthority = await loadConfiguredPermissionAuthority(
    config.value,
  );
  if (!permissionAuthority.ok) {
    dependencies.writeStderr(
      `${projectAnalysisError(permissionAuthority.error).message}\n`,
    );
    return 1;
  }

  const session = createBinarySession(config.value, logger);
  const browserObservation = new CdpBrowserProvider();
  const electronObservation = new CdpElectronProvider();
  const opened = await openInitialTarget(
    session,
    config.value,
    serverLogger,
    dependencies.writeStderr,
  );
  if (!opened.ok) return opened.exitCode;
  const runtimeState = createRuntimeState(config.value);
  const transport = await startMcpTransport(dependencies, session, {
    logger,
    serverLogger,
    browserObservation,
    electronObservation,
    permissionAuthority: permissionAuthority.value,
    runtimeState,
  });
  if (!transport.ok) return 1;
  const unregisterReload = registerConfigReload({
    dependencies,
    permissionAuthority: permissionAuthority.value,
    runtimeState,
    liveServers: transport.liveServers,
    serverLogger,
  });
  createShutdown({
    handle: transport.handle,
    session,
    permissionAuthority: permissionAuthority.value,
    unregisterReload,
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
