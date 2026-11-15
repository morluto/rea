import { snapshotEnvironment } from "../process/snapshotEnvironment.js";
import { HOST_PLATFORM } from "../platform/HostPlatform.js";

/** Capture the selected provider environment at server construction time. */
export const captureProviderEnvironment = (
  providerEnvironment: Readonly<NodeJS.ProcessEnv> | undefined,
  serverEnvironment: Readonly<NodeJS.ProcessEnv>,
): Readonly<NodeJS.ProcessEnv> =>
  snapshotEnvironment(
    providerEnvironment ?? serverEnvironment,
    HOST_PLATFORM.platform,
  );
