import type { ProviderIdentity } from "../application/AnalysisProvider.js";

/** Public identity committed by macOS-native inspection observations. */
export const NATIVE_MACOS_PROVIDER_IDENTITY: ProviderIdentity = Object.freeze({
  id: "native-macos",
  name: "macOS native inspection utilities",
  version: null,
});
