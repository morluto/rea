import type { IdaMcpConnectionDependencies } from "../../src/ida/IdaMcpConnection.js";
import { HOST_PLATFORM } from "../../src/platform/HostPlatform.js";

/**
 * IDA connection dependencies for tests: the running host's platform, as
 * composition passes it, plus any test overrides (including `platform`).
 */
export const idaConnectionDependencies = (
  overrides: Partial<IdaMcpConnectionDependencies> = {},
): IdaMcpConnectionDependencies => ({
  platform: HOST_PLATFORM.platform,
  ...overrides,
});
