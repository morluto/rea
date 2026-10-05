import type { BinarySessionPort } from "../../application/BinarySession.js";
import type { Logger } from "../../logger.js";

/** Shared services for registering managed-code workflow tools. */
export interface ManagedWorkflowToolRegistration {
  readonly logger: Logger;
  readonly recordEvidence: BinarySessionPort["recordEvidence"] | undefined;
  readonly recordEvidenceWithUnknown:
    | BinarySessionPort["recordEvidenceWithUnknown"]
    | undefined;
  readonly session: BinarySessionPort;
}
