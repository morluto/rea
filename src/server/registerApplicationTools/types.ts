import type { BinarySessionPort } from "../../application/BinarySession.js";
import type { Logger } from "../../logger.js";

/** Shared services for registering JavaScript application graph workflows. */
export interface ApplicationToolRegistration {
  readonly logger: Logger;
  readonly recordEvidence: BinarySessionPort["recordEvidence"] | undefined;
  readonly recordEvidenceWithUnknown:
    | BinarySessionPort["recordEvidenceWithUnknown"]
    | undefined;
}
