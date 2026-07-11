#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";

import {
  serveStdio,
  type StdioServerHandle,
} from "@modelcontextprotocol/server/stdio";

import { parseConfig } from "./config.js";
import { BinarySession } from "./application/BinarySession.js";
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
  const session = new BinarySession(
    (target) =>
      new HopperClient({
        launcher: new HopperApplicationLauncher({
          launcherPath: config.value.hopperLauncherPath,
          targetPath: target.path,
          targetKind: target.kind,
          loaderArgs:
            config.value.hopperLoaderArgs.length > 0
              ? config.value.hopperLoaderArgs
              : target.loaderArgs,
          bridgeScriptPath,
        }),
      }),
  );
  if (config.value.hopperTargetPath !== undefined) {
    const opened = await session.open(config.value.hopperTargetPath);
    if (!opened.ok) {
      process.stderr.write(`${opened.error._tag}: ${opened.error.message}\n`);
      return 1;
    }
  }
  let handle: StdioServerHandle;
  try {
    handle = serveStdio(() => createServer(session, session), {
      onerror: () => {
        process.stderr.write("MCP stdio transport error\n");
      },
    });
  } catch {
    await session.close();
    process.stderr.write("Failed to start MCP stdio transport\n");
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
  pathToFileURL(realpathSync(entryPath)).href === import.meta.url
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
