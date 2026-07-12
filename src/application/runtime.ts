import type { AppConfig } from "../config.js";
import { BinarySession } from "./BinarySession.js";
import { HopperProvider } from "../hopper/HopperProvider.js";
import { NativeMacOSProvider } from "../native/NativeMacOSProvider.js";
import { ArtifactProvider } from "../artifacts/ArtifactProvider.js";
import { CompositeProvider } from "./CompositeProvider.js";
import { silentLogger, type Logger } from "../logger.js";

/**
 * Compose the target-switching runtime shared directly by CLI and MCP adapters.
 * This is the sole production wiring point for Hopper so neither adapter shells
 * out to the other and both retain identical loader and bridge semantics.
 */
export const createBinarySession = (
  config: AppConfig,
  logger: Logger = silentLogger,
): BinarySession => {
  return new BinarySession(
    new CompositeProvider([
      new ArtifactProvider(),
      new NativeMacOSProvider(),
      new HopperProvider(config, logger),
    ]),
  );
};
