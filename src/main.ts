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
import { readProjectPermissionStore } from "./application/ProjectPermissionStore.js";
import { loadConfiguredPermissionAuthority } from "./application/PermissionConfiguration.js";
import { CdpBrowserProvider } from "./browser/CdpBrowserProvider.js";
import { CdpElectronProvider } from "./browser/CdpElectronProvider.js";
import type { PermissionGrant } from "./domain/permissionPolicy.js";

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
  readonly registerReload?: (handler: () => void) => () => void;
  readonly createServer?: typeof createServer;
  readonly readProjectPermissionStore?: typeof readProjectPermissionStore;
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
  let currentConfig = config.value;
  const runtimeProcessPolicy = {
    ...config.value.processExecutionPolicy,
    executableRoots: [...config.value.processExecutionPolicy.executableRoots],
    workingRoots: [...config.value.processExecutionPolicy.workingRoots],
    allowedEnvironment: [
      ...config.value.processExecutionPolicy.allowedEnvironment,
    ],
  };
  const runtimeEvidencePolicy = {
    ...config.value.evidenceFilePolicy,
    roots: [...config.value.evidenceFilePolicy.roots],
  };
  const runtimeSnapshotPolicy = {
    ...config.value.analysisSnapshotFilePolicy,
    roots: [...config.value.analysisSnapshotFilePolicy.roots],
  };
  const runtimeInvestigationRoots = [...config.value.investigationInputRoots];
  const liveServers = new Set<ReturnType<typeof createServer>>();
  let handle: StdioServerHandle;
  try {
    handle = dependencies.serve(
      () => {
        const server = (dependencies.createServer ?? createServer)(
          session,
          session,
          {
            logger,
            processPolicy: runtimeProcessPolicy,
            evidenceFilePolicy: runtimeEvidencePolicy,
            investigationInputRoots: runtimeInvestigationRoots,
            analysisSnapshotFilePolicy: runtimeSnapshotPolicy,
            permissionAuthority: permissionAuthority.value,
            browserObservation,
            electronObservation,
            artifactIntegrityContinueEnabled: () =>
              currentConfig.artifactIntegrityContinueEnabled,
            availabilityPolicy: () => ({
              processCaptureEnabled:
                currentConfig.processExecutionPolicy.enabled,
              evidenceFileRoots: currentConfig.evidenceFilePolicy.roots.length,
              browserObservationEnabled:
                currentConfig.browserObservationEnabled &&
                currentConfig.browserCdpEndpoints.length > 0 &&
                currentConfig.browserAllowedOrigins.length > 0,
              electronObservationEnabled:
                currentConfig.electronObservationEnabled &&
                currentConfig.electronCdpEndpoints.length > 0 &&
                currentConfig.electronFileRoots.length > 0,
            }),
          },
        );
        liveServers.add(server);
        return server;
      },
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

  let reloadQueue = Promise.resolve();
  const unregisterReload =
    dependencies.registerReload?.(() => {
      const refreshed = parseConfig(dependencies.env);
      if (!refreshed.ok) {
        serverLogger.error("Reloaded permission policy is invalid");
        return;
      }
      reloadQueue = reloadQueue.then(async () => {
        let projectGrants: readonly PermissionGrant[] = [];
        if (
          refreshed.value.permissionProjectRoot !== undefined &&
          refreshed.value.permissionProjectStore !== undefined
        ) {
          const project = await (
            dependencies.readProjectPermissionStore ??
            readProjectPermissionStore
          )(
            refreshed.value.permissionProjectStore,
            refreshed.value.permissionProjectRoot,
          );
          if (!project.ok) {
            serverLogger.error("Reloaded project grants could not be read");
            return;
          }
          projectGrants = project.value?.grants ?? [];
        }
        const reloaded =
          await permissionAuthority.value.replaceConfiguredPolicy({
            ceilings: refreshed.value.permissionCeilings,
            administratorGrants: refreshed.value.administratorPermissionGrants,
            projectGrants,
          });
        if (!reloaded.ok) {
          serverLogger.error("Reloaded permission policy could not be applied");
          return;
        }
        currentConfig = refreshed.value;
        Object.assign(
          runtimeProcessPolicy,
          refreshed.value.processExecutionPolicy,
        );
        Object.assign(
          runtimeEvidencePolicy,
          refreshed.value.evidenceFilePolicy,
        );
        Object.assign(
          runtimeSnapshotPolicy,
          refreshed.value.analysisSnapshotFilePolicy,
        );
        runtimeInvestigationRoots.splice(
          0,
          runtimeInvestigationRoots.length,
          ...refreshed.value.investigationInputRoots,
        );
        for (const server of liveServers) server.sendToolListChanged();
      });
    }) ?? (() => undefined);

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    shutdownPromise ??= (async () => {
      unregisterReload();
      await handle.close();
      await session.close();
      permissionAuthority.value.clearSessionGrants();
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
