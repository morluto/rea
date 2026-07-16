import type { AppConfig } from "../config.js";
import { BinarySession } from "./BinarySession.js";
import { HopperProvider } from "../hopper/HopperProvider.js";
import { GhidraProvider } from "../ghidra/GhidraProvider.js";
import { NativeMacOSProvider } from "../native/NativeMacOSProvider.js";
import { ArtifactProvider } from "../artifacts/ArtifactProvider.js";
import { ManagedStaticProvider } from "../dotnet/ManagedStaticProvider.js";
import { silentLogger, type Logger } from "../logger.js";
import { AnalysisProviderRegistry } from "./AnalysisProviderRegistry.js";
import { SessionProviderRouter } from "./SessionProviderRouter.js";

/**
 * Compose the target-switching runtime shared directly by CLI and MCP adapters.
 * This is the sole production wiring point, so both adapters share identical
 * provider selection, profile, lifecycle, and Evidence semantics.
 */
export const createBinarySession = (
  config: AppConfig,
  logger: Logger = silentLogger,
): BinarySession => {
  const hopper = new HopperProvider(config, logger);
  const ghidra = new GhidraProvider(config, logger);
  return new BinarySession(
    SessionProviderRouter.selectable(
      new AnalysisProviderRegistry([hopper, ghidra], config.analysisProvider),
      [
        new ArtifactProvider(
          config.artifactNativeMountEnabled,
          config.artifactIntegrityContinueEnabled,
        ),
        new NativeMacOSProvider(),
        new ManagedStaticProvider(),
      ],
    ),
  );
};
