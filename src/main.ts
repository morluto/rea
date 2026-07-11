#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

import {
  serveStdio,
  type StdioServerHandle,
} from "@modelcontextprotocol/server/stdio";

import { parseConfig } from "./config.js";
import { HopperApplicationLauncher } from "./hopper/BridgeLauncher.js";
import { HopperClient } from "./hopper/HopperClient.js";
import { createServer } from "./server/createServer.js";

/** Start the production stdio server and install owned shutdown handlers. */
export const run = async (): Promise<number> => {
  const config = parseConfig(process.env);
  if (!config.ok) {
    process.stderr.write(`${config.error._tag}: ${config.error.message}\n`);
    return 1;
  }

  const bridgeScriptPath = fileURLToPath(
    new URL("../bridge/hopper_bridge.py", import.meta.url),
  );
  const hopper = new HopperClient({
    launcher: new HopperApplicationLauncher({
      launcherPath: config.value.hopperLauncherPath,
      targetPath: config.value.hopperTargetPath,
      targetKind: config.value.hopperTargetKind,
      loaderArgs: config.value.hopperLoaderArgs,
      bridgeScriptPath,
    }),
  });
  let handle: StdioServerHandle;
  try {
    handle = serveStdio(() => createServer(hopper), {
      onerror: () => {
        process.stderr.write("MCP stdio transport error\n");
      },
    });
  } catch {
    await hopper.close();
    process.stderr.write("Failed to start MCP stdio transport\n");
    return 1;
  }

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    shutdownPromise ??= (async () => {
      await handle.close();
      await hopper.close();
    })();
    return shutdownPromise;
  };
  const requestShutdown = (): void => {
    shutdown().catch(() => {
      process.exitCode = 1;
      process.stderr.write("Failed to shut down cleanly\n");
    });
  };

  process.once("SIGINT", requestShutdown);
  process.once("SIGTERM", requestShutdown);
  process.stdin.once("end", requestShutdown);
  process.stdin.once("close", requestShutdown);
  return 0;
};

const entryPath = process.argv[1];
if (
  entryPath !== undefined &&
  pathToFileURL(entryPath).href === import.meta.url
) {
  run()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch(() => {
      process.stderr.write("Unexpected server startup failure\n");
      process.exitCode = 1;
    });
}
