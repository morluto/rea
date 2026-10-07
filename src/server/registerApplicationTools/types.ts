import type {
  EvidenceWriter,
  EvidenceReader,
  EvidenceUnknownWriter,
} from "../../application/investigation/InvestigationRecordPort.js";
import type { Logger } from "../../logger.js";

/** Shared services for registering JavaScript application graph workflows. */
export interface ApplicationToolRegistration {
  readonly logger: Logger;
  readonly evidenceById: EvidenceReader["evidenceById"] | undefined;
  readonly recordEvidence: EvidenceWriter["recordEvidence"] | undefined;
  readonly recordEvidenceWithUnknown:
    | EvidenceUnknownWriter["recordEvidenceWithUnknown"]
    | undefined;
}
