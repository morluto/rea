import {
  createAnalysisExecution,
  type ProviderIdentity,
  type CapabilityDescriptor,
  type ProviderAvailability,
  type ProviderTargetSupport,
} from "../../src/ports/AnalysisProvider.js";
import { ok } from "../../src/domain/result.js";

const FIXTURE_PROVIDER = {
  id: "fixture",
  name: "Fixture analysis provider",
  version: "1",
} as const;

/** Wrap fixture output in the same atomic provider envelope as production. */
export const observed = (value: unknown) =>
  ok(createAnalysisExecution(value, FIXTURE_PROVIDER));

export const availableFixtureProvider = (): ProviderAvailability => ({
  status: "available",
  code: null,
  reason: null,
  diagnostics: {},
});

export const supportedFixtureTarget = (): ProviderTargetSupport => ({
  status: "supported",
  code: null,
  reason: null,
  diagnostics: {},
});

export const fixtureAddressNameCapability = (
  provider: ProviderIdentity,
): CapabilityDescriptor => ({
  provider,
  operation: "address_name",
  available: true,
  reason: null,
  effects: {
    mutatesArtifact: false,
    launchesProcess: true,
    mayShowUi: false,
    mayAccessNetwork: false,
    mayWriteFilesystem: false,
    changesPermissions: false,
    requiresRoot: false,
  },
  limitations: [],
});
