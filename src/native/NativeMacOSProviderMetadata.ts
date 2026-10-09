import type {
  CapabilityDescriptor,
  ProviderIdentity,
} from "../application/AnalysisProvider.js";
import { NATIVE_TOOL_CONTRACTS } from "../contracts/native/nativeToolContracts.js";

/** Public identity committed by macOS-native inspection observations. */
export const NATIVE_MACOS_PROVIDER_IDENTITY: ProviderIdentity = Object.freeze({
  id: "native-macos",
  name: "macOS native inspection utilities",
  version: null,
});
/** Operations whose target process can show UI, use the network and write files. */
const OWNED_PROCESS_OPERATIONS: ReadonlySet<string> = new Set([
  "capture_native_ui_scenario",
  "observe_native_calls",
]);

/** Declare native host coverage without creating a command runner. */
export const nativeMacOSCapabilities = (
  platform: NodeJS.Platform = process.platform,
): readonly CapabilityDescriptor[] => {
  const available = platform === "darwin";
  return Object.freeze(
    [
      ...NATIVE_TOOL_CONTRACTS,
      { name: "inspect_native_dispatch_metadata" as const },
    ].map((contract): CapabilityDescriptor => {
      const availability = available
        ? ({ available: true, reason: null } as const)
        : ({
            available: false,
            availabilityCode: "unsupported_host",
            reason: "Native macOS utilities require macOS.",
          } as const);
      return Object.freeze({
        provider: NATIVE_MACOS_PROVIDER_IDENTITY,
        operation: contract.name,
        ...availability,
        effects: Object.freeze({
          mutatesArtifact: false,
          launchesProcess: contract.name !== "inspect_native_dispatch_metadata",
          mayShowUi: OWNED_PROCESS_OPERATIONS.has(contract.name),
          mayAccessNetwork: OWNED_PROCESS_OPERATIONS.has(contract.name),
          mayWriteFilesystem:
            OWNED_PROCESS_OPERATIONS.has(contract.name) ||
            contract.name === "observe_native_ui",
          changesPermissions: false,
          requiresRoot: false,
        }),
        limitations: Object.freeze([
          "Availability and textual formats depend on the installed macOS/Xcode toolchain.",
        ]),
      });
    }),
  );
};
