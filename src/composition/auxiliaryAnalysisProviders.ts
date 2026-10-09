import { snapshotEnvironment } from "../process/snapshotEnvironment.js";
import type { LazyAnalysisProvider } from "../application/binary/LazyAnalysisProvider.js";
import {
  ARTIFACT_PROVIDER_IDENTITY,
  artifactCapabilities,
} from "../artifacts/ArtifactProviderMetadata.js";
import {
  MANAGED_STATIC_PROVIDER_IDENTITY,
  managedStaticCapabilities,
} from "../dotnet/ManagedStaticProviderMetadata.js";
import {
  NATIVE_MACOS_PROVIDER_IDENTITY,
  nativeMacOSCapabilities,
} from "../native/NativeMacOSProviderMetadata.js";

type AuxiliaryProviderDeclaration = ConstructorParameters<
  typeof LazyAnalysisProvider
>[0];

/** Wire the three existing auxiliary AnalysisProvider implementations lazily. */
export const auxiliaryAnalysisProviderDeclarations = (
  selectedEnvironment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform = process.platform,
): readonly AuxiliaryProviderDeclaration[] => {
  const environment = snapshotEnvironment(selectedEnvironment, platform);
  return [
    {
      identity: ARTIFACT_PROVIDER_IDENTITY,
      capabilities: artifactCapabilities(platform),
      load: async () => {
        const { ArtifactProvider } =
          await import("../artifacts/ArtifactProvider.js");
        return new ArtifactProvider(environment, platform);
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
      identity: MANAGED_STATIC_PROVIDER_IDENTITY,
      capabilities: managedStaticCapabilities(),
      load: async () => {
        const { ManagedStaticProvider } =
          await import("../dotnet/ManagedStaticProvider.js");
        return new ManagedStaticProvider();
      },
    },
  ];
};
