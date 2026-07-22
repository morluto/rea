import type { McpServer } from "@modelcontextprotocol/server";

import type { BinarySessionPort } from "../application/BinarySession.js";
import type { ElectronObservationPort } from "../application/ElectronObservationPort.js";
import { analyzeJavaScriptApplicationValidated } from "../application/JavaScriptApplicationService.js";
import { reconcileJavaScriptRuntimeEvidenceValidated } from "../application/JavaScriptRuntimeReconciliationService.js";
import {
  inspectElectronPage,
  listElectronTargets,
} from "../application/ElectronObservationService.js";
import type { PermissionAuthority } from "../application/PermissionAuthority.js";
import {
  analyzeJavaScriptApplicationToolInputSchema,
  ELECTRON_TOOL_CONTRACTS,
} from "../contracts/electronToolContracts.js";
import {
  inspectElectronPageInputSchema,
  listElectronTargetsInputSchema,
} from "../domain/electronObservation.js";
import { reconcileJavaScriptRuntimeInputSchema } from "../domain/javascriptRuntimeReconciliationSchemas.js";
import {
  registerObservationTool,
  type ObservationToolRegistration,
} from "./observationToolRegistration.js";
import { summarizeJavaScriptApplicationEvidence } from "./javascriptApplicationResult.js";

interface ElectronToolRegistration {
  readonly logger: ObservationToolRegistration["logger"];
  readonly electron: ElectronObservationPort | undefined;
  readonly permissionAuthority: PermissionAuthority | undefined;
  readonly recordEvidence: BinarySessionPort["recordEvidence"] | undefined;
}

/** Register Electron tools even when provider or permission policy is absent. */
export const registerElectronTools = (
  server: McpServer,
  options: ElectronToolRegistration,
): void => {
  const [listContract, inspectContract, analyzeContract, reconcileContract] =
    ELECTRON_TOOL_CONTRACTS;

  registerObservationTool(server, options, {
    contract: listContract,
    schema: listElectronTargetsInputSchema,
    execute: (parsed, { signal }) =>
      listElectronTargets(
        options.electron,
        options.permissionAuthority,
        parsed,
        {
          signal,
        },
      ),
  });
  registerObservationTool(server, options, {
    contract: inspectContract,
    schema: inspectElectronPageInputSchema,
    execute: (parsed, { signal, progress }) =>
      inspectElectronPage(
        options.electron,
        options.permissionAuthority,
        parsed,
        {
          signal,
          progress,
        },
      ),
  });
  registerObservationTool(server, options, {
    contract: analyzeContract,
    schema: analyzeJavaScriptApplicationToolInputSchema,
    execute: (parsed, { signal, progress }) =>
      analyzeJavaScriptApplicationValidated(
        options.permissionAuthority,
        parsed,
        { signal, progress },
      ),
    projectEvidence: (evidence, parsed) => {
      const summary = summarizeJavaScriptApplicationEvidence(evidence);
      return parsed.detail === "full"
        ? { structured: evidence.normalized_result, text: summary }
        : { structured: summary };
    },
  });
  registerObservationTool(server, options, {
    contract: reconcileContract,
    schema: reconcileJavaScriptRuntimeInputSchema,
    execute: (parsed) =>
      Promise.resolve(reconcileJavaScriptRuntimeEvidenceValidated(parsed)),
  });
};
