import type {
  EvidenceWriter,
  EvidenceUnknownWriter,
} from "../../application/investigation/InvestigationRecordPort.js";
import type { BinarySessionPort } from "../../application/binary/BinarySession.js";
import type { Logger } from "../../logger.js";

/** Shared services for registering managed-code workflow tools. */
export interface ManagedWorkflowToolRegistration {
  readonly logger: Logger;
  readonly recordEvidence: EvidenceWriter["recordEvidence"] | undefined;
  readonly recordEvidenceWithUnknown:
    | EvidenceUnknownWriter["recordEvidenceWithUnknown"]
    | undefined;
  readonly session: BinarySessionPort;
}
