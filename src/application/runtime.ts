import type { AppConfig } from "../config.js";
import type { BinarySession } from "./BinarySession.js";
import { HopperProvider } from "../hopper/HopperProvider.js";
import { GhidraProvider } from "../ghidra/GhidraProvider.js";
import { BinaryNinjaProvider } from "../binaryNinja/BinaryNinjaProvider.js";
import { silentLogger, type Logger } from "../logger.js";
import { GENERATED_AUXILIARY_PROVIDERS } from "../generatedMcpToolCatalog.js";
import { AnalysisProviderRegistry } from "./AnalysisProviderRegistry.js";
import { composeBinarySession } from "./BinarySessionComposition.js";
import { nativeHostCapabilities } from "../native/NativeHostCapabilities.js";
import { LazyAnalysisProvider } from "./LazyAnalysisProvider.js";
import { ManagedStaticProvider } from "../dotnet/ManagedStaticProvider.js";
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
  const auxiliary = new Map(
    GENERATED_AUXILIARY_PROVIDERS.map((provider) => [
      provider.identity.id,
      provider,
    ]),
  );
  const lazyProvider = (
    id: string,
    load: ConstructorParameters<typeof LazyAnalysisProvider>[0]["load"],
  ) => {
    const generated = auxiliary.get(id);
    if (generated === undefined)
      throw new TypeError(`Missing generated provider metadata for ${id}`);
    return new LazyAnalysisProvider({
      ...generated,
      capabilities: nativeHostCapabilities(generated.capabilities),
      load,
    });
  };
  return composeBinarySession(
    new AnalysisProviderRegistry(
      [hopper, ghidra, new BinaryNinjaProvider(config)],
      config.analysisProvider,
    ),
    [
      lazyProvider("rea-artifact-graph", async () => {
        const { ArtifactProvider } =
          await import("../artifacts/ArtifactProvider.js");
        return new ArtifactProvider();
      }),
      lazyProvider("native-macos", async () => {
        const { NativeMacOSProvider } =
          await import("../native/NativeMacOSProvider.js");
        return new NativeMacOSProvider();
      }),
      lazyProvider("rea-dotnet-static", async () => {
        const { ManagedStaticProvider } =
          await import("../dotnet/ManagedStaticProvider.js");
        return new ManagedStaticProvider();
      }),
    ],
  );
};

/** Compose an execution-free managed session without native provider selection. */
export const createManagedBinarySession = (): BinarySession =>
  composeBinarySession(
    SessionProviderRouter.selectable(new AnalysisProviderRegistry([]), [
      new ManagedStaticProvider(),
    ]),
  );
