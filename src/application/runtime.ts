import { fileURLToPath } from "node:url";

import type { AppConfig } from "../config.js";
import { BinarySession } from "./BinarySession.js";
import { HopperApplicationLauncher } from "../hopper/BridgeLauncher.js";
import { HopperClient } from "../hopper/HopperClient.js";

/** Create the target-switching session used by both the CLI and MCP adapters. */
export const createBinarySession = (config: AppConfig): BinarySession => {
  const bridgeScriptPath = fileURLToPath(
    new URL("../../bridge/hopper_bridge.py", import.meta.url),
  );
  return new BinarySession(
    (target) =>
      new HopperClient({
        launcher: new HopperApplicationLauncher({
          launcherPath: config.hopperLauncherPath,
          targetPath: target.path,
          targetKind: target.kind,
          loaderArgs:
            config.hopperLoaderArgs.length > 0
              ? config.hopperLoaderArgs
              : target.loaderArgs,
          bridgeScriptPath,
        }),
      }),
  );
};
