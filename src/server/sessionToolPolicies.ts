import type { EvidenceFilePolicy } from "../domain/evidenceBundle.js";
import type { ProcessExecutionPolicy } from "../domain/processCapture.js";

/** Fail-closed process policy used when operator configuration is absent. */
export const DENY_PROCESS_POLICY: ProcessExecutionPolicy = {
  enabled: false,
  executableRoots: [],
  workingRoots: [],
  allowedEnvironment: [],
  allowExternalNetwork: false,
};

/** Fail-closed evidence filesystem policy used without approved roots. */
export const DENY_EVIDENCE_FILE_POLICY: EvidenceFilePolicy = {
  roots: [],
  maxBytes: 64 * 1024 * 1024,
  maxDepth: 64,
  maxStringLength: 1024 * 1024,
  maxNodes: 1_000_000,
};

export { PROCESS_PROVIDER } from "../application/ProcessEvidence.js";
export {
  ARTIFACT_COMPARISON_PROVIDER,
  BUNDLE_COMPARISON_PROVIDER,
  CALL_PATH_PROVIDER,
  CHANGED_BEHAVIOR_PROVIDER,
  FUNCTION_COMPARISON_PROVIDER,
  RECONSTRUCTION_PROVIDER,
  STATIC_RUNTIME_PROVIDER,
} from "../application/InvestigationProviders.js";
