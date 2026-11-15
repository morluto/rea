import type { EvidenceReader } from "../../application/investigation/InvestigationRecordPort.js";
import type { Logger } from "pino";
import type { WithAdmittedAnalysis } from "../analysisAdmission.js";

/** Shared services for the application tools that deliver plain results. */
export interface ApplicationToolRegistration {
  readonly withAdmittedAnalysis?: WithAdmittedAnalysis;
  readonly logger: Logger;
  readonly evidenceById: EvidenceReader["evidenceById"] | undefined;
}
