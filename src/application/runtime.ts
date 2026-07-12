import { fileURLToPath } from "node:url";

import type { AppConfig } from "../config.js";
import { BinarySession } from "./BinarySession.js";
import { HopperApplicationLauncher } from "../hopper/BridgeLauncher.js";
import { HopperClient } from "../hopper/HopperClient.js";

/**
 * Compose the target-switching runtime shared directly by CLI and MCP adapters.
 * This is the sole production wiring point for Hopper so neither adapter shells
 * out to the other and both retain identical loader and bridge semantics.
 */
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
