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

/**
 * Start the long-lived MCP adapter and install idempotent shutdown handlers.
 * The adapter owns its BinarySession for the process lifetime; EOF and process
 * signals close bridge resources without assuming ownership of the Hopper app.
 */
export const run = async (): Promise<number> => {
  const config = parseConfig(process.env);
  if (!config.ok) {
    process.stderr.write(`${config.error._tag}: ${config.error.message}\n`);
    return 1;
  }

  const session = createBinarySession(config.value);
  if (config.value.hopperTargetPath !== undefined) {
    const opened = await session.open(config.value.hopperTargetPath, {
      targetKind: config.value.hopperTargetKind,
    });
    if (!opened.ok) {
      await session.close();
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
