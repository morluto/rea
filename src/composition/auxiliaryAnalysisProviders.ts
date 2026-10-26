import { HOST_PLATFORM } from "../platform/HostPlatform.js";
import type { AnalysisSettingsReader } from "../domain/analysisSettings.js";
import { snapshotEnvironment } from "../process/snapshotEnvironment.js";
import type { LazyAnalysisProvider } from "../application/binary/LazyAnalysisProvider.js";
import { artifactCapabilities } from "../artifacts/ArtifactProviderMetadata.js";
import {
  ARTIFACT_GRAPH_PROVIDER,
  MANAGED_STATIC_PROVIDER,
} from "../domain/investigationProviders.js";
import { managedStaticCapabilities } from "../dotnet/ManagedStaticProviderMetadata.js";
import { nativeMacOSCapabilities } from "../native/NativeMacOSProviderMetadata.js";
import { NATIVE_MACOS_PROVIDER_IDENTITY } from "../native/NativeMacosProviderIdentity.js";
import {
  UNICORN_PROVIDER_IDENTITY,
  unicornCapabilities,
} from "../unicorn/UnicornProviderMetadata.js";

type AuxiliaryProviderDeclaration = ConstructorParameters<
  typeof LazyAnalysisProvider
>[0];

/** Declare the lazy execution-free .NET static provider wiring. */
export const managedStaticProviderDeclaration =
  (): AuxiliaryProviderDeclaration => ({
    identity: MANAGED_STATIC_PROVIDER,
    capabilities: managedStaticCapabilities(),
    load: async () => {
      const { ManagedStaticProvider } =
        await import("../dotnet/ManagedStaticProvider.js");
      return new ManagedStaticProvider();
    },
  });

/** Wire the auxiliary AnalysisProvider implementations lazily. */
export const auxiliaryAnalysisProviderDeclarations = (
  selectedEnvironment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform = HOST_PLATFORM.platform,
  settings?: AnalysisSettingsReader,
): readonly AuxiliaryProviderDeclaration[] => {
  const environment = snapshotEnvironment(selectedEnvironment, platform);
  return [
    {
      identity: ARTIFACT_GRAPH_PROVIDER,
      capabilities: artifactCapabilities(platform),
      load: async () => {
        const { ArtifactProvider } =
          await import("../artifacts/ArtifactProvider.js");
        return new ArtifactProvider(environment, platform, settings);
      },
    },
    {
      identity: NATIVE_MACOS_PROVIDER_IDENTITY,
      capabilities: nativeMacOSCapabilities(platform),
      load: async () => {
        const { NativeMacOSProvider } =
          await import("../native/NativeMacOSProvider.js");
        return new NativeMacOSProvider(environment, undefined, platform);
      },
    },
    {
      identity: UNICORN_PROVIDER_IDENTITY,
      capabilities: unicornCapabilities(environment, platform),
      load: async () => {
        const { UnicornProvider } =
          await import("../unicorn/UnicornProvider.js");
        return new UnicornProvider(environment, platform);
      },
    },
    managedStaticProviderDeclaration(),
  ];
};
