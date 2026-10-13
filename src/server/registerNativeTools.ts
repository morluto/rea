import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";

import { NATIVE_TOOL_CONTRACTS } from "../contracts/native/nativeToolContracts.js";
import type { EvidenceLookup } from "../application/EvidenceInputResolver.js";
import {
  requireAnalysisViewRetention,
  summarizeRetainedAnalysis,
} from "../application/analysisView/AnalysisViewService.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { ok } from "../domain/result.js";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import type { Logger } from "pino";
import { registerEvidenceTools } from "./registerEvidenceTools.js";

/** Delivery detail selects a response shape; it never reaches the tools or Evidence identity. */
const withoutDelivery = (
  operation: string,
  parameters: Readonly<Record<string, JsonValue>>,
): Readonly<Record<string, JsonValue>> => {
  if (operation !== "inspect_macho") return parameters;
  const { detail: _detail, ...selected } = parameters;
  return selected;
};

/** Register macOS native contracts; Mach-O inspection can deliver a retained summary. */
export const registerNativeTools = (
  server: EvidenceMcpServer,
  options: {
    readonly logger: Logger;
    readonly activeTarget: (() => BinaryTarget | undefined) | undefined;
    readonly recordEvidence: EvidenceWriter["recordEvidence"] | undefined;
    readonly evidenceById?: EvidenceLookup | undefined;
    readonly withAdmittedAnalysis: import("./analysisAdmission.js").WithAdmittedAnalysis;
  },
): void => {
  const retention = {
    recordEvidence: options.recordEvidence,
    evidenceById: options.evidenceById,
  };
  registerEvidenceTools(server, NATIVE_TOOL_CONTRACTS, {
    ...options,
    parametersForExecution: withoutDelivery,
    parametersForEvidence: withoutDelivery,
    preflight: (operation, parameters) =>
      operation === "inspect_macho" && parameters.detail === "summary"
        ? requireAnalysisViewRetention(operation, retention)
        : ok(null),
    projectEvidence: (operation, parameters, evidence) =>
      operation === "inspect_macho" && parameters.detail === "summary"
        ? summarizeRetainedAnalysis(evidence, retention)
        : ok(evidence),
  });
};
