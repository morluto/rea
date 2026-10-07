import type { AppConfig } from "../config.js";
import type { BinarySession } from "./binary/BinarySession.js";
import { HopperProvider } from "../hopper/HopperProvider.js";
import { GhidraProvider } from "../ghidra/GhidraProvider.js";
import { IdaProvider } from "../ida/IdaProvider.js";
import { silentLogger, type Logger } from "../logger.js";
import { auxiliaryAnalysisProviderDeclarations } from "../composition/auxiliaryAnalysisProviders.js";
import { AnalysisProviderRegistry } from "./binary/AnalysisProviderRegistry.js";
import { composeBinarySession } from "./binary/BinarySessionComposition.js";
import { LazyAnalysisProvider } from "./binary/LazyAnalysisProvider.js";
import { ManagedStaticProvider } from "../dotnet/ManagedStaticProvider.js";
import { SessionProviderRouter } from "./binary/SessionProviderRouter.js";

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
  const ida = new IdaProvider(config);
  return composeBinarySession(
    new AnalysisProviderRegistry(
      [hopper, ghidra, ida],
      config.analysisProvider,
    ),
    auxiliaryAnalysisProviderDeclarations().map(
      (declaration) => new LazyAnalysisProvider(declaration),
    ),
  );
};

/** Compose an execution-free managed session without native provider selection. */
export const createManagedBinarySession = (): BinarySession =>
  composeBinarySession(
    SessionProviderRouter.selectable(new AnalysisProviderRegistry([]), [
      new ManagedStaticProvider(),
    ]),
  );
