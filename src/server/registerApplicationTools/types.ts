import type { BinarySessionPort } from "../../application/BinarySession.js";
import type { EvidenceLookup } from "../../application/EvidenceReferenceResolver.js";
import type { JavaScriptReplayDependencies } from "../../application/JavaScriptReplayService.js";
import type { PermissionAuthority } from "../../application/PermissionAuthority.js";
import type { EvidenceFilePolicy } from "../../domain/evidenceBundle.js";
import type { Logger } from "../../logger.js";

/** Shared services for registering JavaScript application graph workflows. */
export interface ApplicationToolRegistration {
  readonly logger: Logger;
  readonly recordEvidence: BinarySessionPort["recordEvidence"] | undefined;
  readonly recordEvidenceWithUnknown:
    | BinarySessionPort["recordEvidenceWithUnknown"]
    | undefined;
  readonly evidenceLookup: EvidenceLookup | undefined;
  readonly replay: JavaScriptReplayDependencies;
  readonly evidenceFilePolicy: EvidenceFilePolicy;
  readonly permissionAuthority: PermissionAuthority | undefined;
  readonly retainCoverageWorkspace:
    | BinarySessionPort["retainReconstructionCoverageWorkspace"]
    | undefined;
}
