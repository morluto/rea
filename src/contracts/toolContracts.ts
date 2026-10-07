import { NATIVE_TOOL_CONTRACTS } from "./nativeToolContracts.js";
import { ARTIFACT_TOOL_CONTRACTS } from "./artifactToolContracts.js";
import { MANAGED_TOOL_CONTRACTS } from "./managedToolContracts.js";
import { FIRMWARE_TOOL_CONTRACTS } from "./firmwareToolContracts.js";
import { ANDROID_TOOL_CONTRACTS } from "./androidToolContracts.js";
import { MANAGED_WORKFLOW_TOOL_CONTRACTS } from "./managedWorkflowToolContracts.js";
import { BROWSER_PROVIDER_TOOL_CONTRACTS } from "./browserProviderToolContracts.js";
import { ELECTRON_TOOL_CONTRACTS } from "./electronToolContracts.js";
import { JAVASCRIPT_RUNTIME_OBSERVATION_TOOL_CONTRACTS } from "./javascriptRuntimeObservationToolContracts.js";
import { APPLICATION_TOOL_CONTRACTS } from "./applicationToolContracts.js";
import { WEB_SCRIPT_TOOL_CONTRACTS } from "./webScriptToolContracts.js";
import { JAVASCRIPT_RECOVERY_TOOL_CONTRACTS } from "./javascriptRecoveryToolContracts.js";
import { OFFICIAL_TOOL_CONTRACTS } from "./officialToolContracts.js";
import { ENHANCED_TOOL_CONTRACTS } from "./enhancedToolContracts.js";
import { SESSION_TOOL_CONTRACTS } from "./sessionToolContracts.js";

export type { ToolContract } from "./toolContractTypes.js";

/** Complete ordered public inventory used by registration and verification. */
export const TOOL_CONTRACTS = [
  ...OFFICIAL_TOOL_CONTRACTS,
  ...ENHANCED_TOOL_CONTRACTS,
  ...NATIVE_TOOL_CONTRACTS,
  ...ARTIFACT_TOOL_CONTRACTS,
  ...MANAGED_TOOL_CONTRACTS,
  ...ANDROID_TOOL_CONTRACTS,
  ...FIRMWARE_TOOL_CONTRACTS,
  ...MANAGED_WORKFLOW_TOOL_CONTRACTS,
  ...BROWSER_PROVIDER_TOOL_CONTRACTS,
  ...ELECTRON_TOOL_CONTRACTS,
  ...JAVASCRIPT_RUNTIME_OBSERVATION_TOOL_CONTRACTS,
  ...APPLICATION_TOOL_CONTRACTS,
  ...WEB_SCRIPT_TOOL_CONTRACTS,
  ...JAVASCRIPT_RECOVERY_TOOL_CONTRACTS,
  ...SESSION_TOOL_CONTRACTS,
] as const;

/** Resolve a public contract by name while retaining its exact schema types. */
export const toolContract = <
  Name extends (typeof TOOL_CONTRACTS)[number]["name"],
>(
  name: Name,
): Extract<(typeof TOOL_CONTRACTS)[number], { readonly name: Name }> => {
  const contract = TOOL_CONTRACTS.find(
    (
      candidate,
    ): candidate is Extract<
      (typeof TOOL_CONTRACTS)[number],
      { readonly name: Name }
    > => candidate.name === name,
  );
  if (contract === undefined) throw new Error(`Missing tool contract: ${name}`);
  return contract;
};
