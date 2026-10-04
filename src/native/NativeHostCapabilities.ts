import type { CapabilityDescriptor } from "../application/AnalysisProvider.js";

/** Apply native host restrictions to portable provider discovery metadata. */
export const nativeHostCapabilities = (
  capabilities: readonly CapabilityDescriptor[],
  platform: NodeJS.Platform = process.platform,
): readonly CapabilityDescriptor[] => {
  if (platform === "darwin") return capabilities;
  return capabilities.map((capability): CapabilityDescriptor => {
    if (capability.provider.id === "native-macos")
      return {
        ...capability,
        available: false,
        availabilityCode: "unsupported_host",
        reason: "Native macOS utilities require macOS.",
      };
    if (
      capability.provider.id === "rea-artifact-graph" &&
      capability.operation === "inspect_asset_catalog"
    )
      return {
        ...capability,
        available: false,
        availabilityCode: "unsupported_host",
        reason: "Apple asset catalogs require macOS assetutil.",
      };
    return capability;
  });
};
