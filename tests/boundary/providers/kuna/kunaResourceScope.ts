import { HOST_PLATFORM } from "../../../../src/platform/HostPlatform.js";
import { createInspectionResources } from "../../../fixtures/inspectionResources.js";
import type { RetainedResourceScope } from "../../../../src/ports/AnalysisProvider.js";
import type { KunaInstallationOptions } from "../../../../src/kuna/KunaInstallation.js";
import { inspectKunaInstallation } from "../../../../src/kuna/KunaInstallation.js";
import { inspectKunaProvider } from "../../../../src/kuna/KunaDoctor.js";

export const withKunaResourceScope = async <T>(
  operation: (owner: RetainedResourceScope) => Promise<T>,
): Promise<T> => {
  const scope = createInspectionResources();
  try {
    return await operation(scope.owner);
  } finally {
    await scope.close();
  }
};

export const inspectKunaInstallationOwned = (
  environment: Readonly<NodeJS.ProcessEnv>,
  options: Omit<KunaInstallationOptions, "resourceScope" | "platform"> & {
    readonly platform?: NodeJS.Platform;
  } = {},
) =>
  withKunaResourceScope((resourceScope) =>
    inspectKunaInstallation(environment, {
      platform: HOST_PLATFORM.platform,
      ...options,
      resourceScope,
    }),
  );

export const inspectKunaProviderOwned = (
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform = HOST_PLATFORM.platform,
) =>
  withKunaResourceScope((resourceScope) =>
    inspectKunaProvider(environment, platform, { resourceScope }),
  );
