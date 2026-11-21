/** Optional integrations whose verified hosts exclude some platforms. */
export const HOST_RESTRICTED_FEATURES = [
  "packetCapture",
  "pcapCapture",
  "signalRecording",
  "evmInterface",
  "binaryLayout",
  "recordedCrash",
  "firmwareInspection",
  "firmwareExtraction",
  "javascriptRecovery",
  "persistentDebugger",
  "lldbDebugger",
] as const;
export type HostRestrictedFeature = (typeof HOST_RESTRICTED_FEATURES)[number];

/**
 * What a tool needs before it can run, declared with its contract and
 * interpreted once by the capability inventory.
 *
 * - `"standalone"`: a built-in workflow over caller-selected input. It needs
 *   no optional provider, deep-analysis provider or host integration, so it
 *   is always available.
 * - `{ host }`: an optional integration that the host must support and the
 *   operator must configure; the inventory owns each feature's configuration
 *   flag and remediation.
 *
 * A contract without a declaration takes its availability from its provider
 * family, its active target, or a named rule in the inventory.
 */
export type ToolAvailabilityDeclaration =
  | "standalone"
  | { readonly host: HostRestrictedFeature };
