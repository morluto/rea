import type { EvidenceFilePolicy } from "../../domain/evidenceBundle.js";
import type { PermissionAuthority } from "../../application/PermissionAuthority.js";

/** Policy inputs shared by all investigation workflow tools. */
export interface InvestigationToolPolicies {
  readonly evidenceFiles: EvidenceFilePolicy;
  readonly inputRoots: readonly string[];
  readonly permissionAuthority?: PermissionAuthority;
  readonly integrityContinueEnabled?: () => boolean;
}

/** Fields used to build an approved residual unknown from a workflow result. */
export interface WorkflowUnknownInput {
  readonly question: string;
  readonly domain: string;
  readonly requiredAuthority: "shipped-artifact" | "controlled-replay" | null;
  readonly requiredConfidence: "observed" | "derived";
  readonly probes: readonly {
    readonly operation: string;
    readonly rationale: string;
  }[];
}
