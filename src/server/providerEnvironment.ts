import { snapshotEnvironment } from "../process/snapshotEnvironment.js";

/** Capture the selected provider environment at server construction time. */
export const captureProviderEnvironment = (
  providerEnvironment: Readonly<NodeJS.ProcessEnv> | undefined,
  serverEnvironment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform,
): Readonly<NodeJS.ProcessEnv> =>
  snapshotEnvironment(providerEnvironment ?? serverEnvironment, platform);
