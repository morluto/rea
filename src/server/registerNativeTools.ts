import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";

import type { AnalysisOperationPort } from "../application/AnalysisProvider.js";
import { NATIVE_TOOL_CONTRACTS } from "../contracts/native/nativeToolContracts.js";
import type { BinaryTarget } from "../domain/binaryTarget.js";
import type { Logger } from "../logger.js";
import { registerEvidenceTools } from "./registerEvidenceTools.js";

/** Register provider-neutral static inspection operations. */
export const registerNativeTools = (
  server: EvidenceMcpServer,
  analysis: AnalysisOperationPort,
  options: {
    readonly logger: Logger;
    readonly activeTarget: (() => BinaryTarget | undefined) | undefined;
    readonly recordEvidence: EvidenceWriter["recordEvidence"] | undefined;
  },
): void => {
  registerEvidenceTools(server, analysis, NATIVE_TOOL_CONTRACTS, options);
};
