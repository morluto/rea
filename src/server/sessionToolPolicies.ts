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

/** Provider identity for controlled process-capture evidence. */
export const PROCESS_PROVIDER = {
  id: "rea-process",
  name: "REA deterministic process harness",
  version: "1",
} as const;

/** Provider identity for deterministic cross-artifact comparisons. */
export const ARTIFACT_COMPARISON_PROVIDER = {
  id: "rea-artifact-comparison",
  name: "REA artifact comparison",
  version: "1",
} as const;

/** Provider identity for deterministic cross-function comparisons. */
export const FUNCTION_COMPARISON_PROVIDER = {
  id: "rea-function-comparison",
  name: "REA function comparison",
  version: "1",
} as const;

/** Provider identity for deterministic Evidence bundle comparisons. */
export const BUNDLE_COMPARISON_PROVIDER = {
  id: "rea-bundle-comparison",
  name: "REA Evidence bundle comparison",
  version: "1",
} as const;

/** Provider identity for comparison-Evidence behavior aggregation. */
export const CHANGED_BEHAVIOR_PROVIDER = {
  id: "rea-changed-behavior",
  name: "REA changed behavior investigation",
  version: "1",
} as const;

/** Provider identity for Evidence-backed call-path reconstruction. */
export const CALL_PATH_PROVIDER = {
  id: "rea-call-path",
  name: "REA call path reconstruction",
  version: "1",
} as const;

/** Provider identity for explicit static/runtime hypothesis correlation. */
export const STATIC_RUNTIME_PROVIDER = {
  id: "rea-static-runtime-correlation",
  name: "REA static/runtime correlation",
  version: "1",
} as const;

/** Provider identity for finite reconstruction specification verification. */
export const RECONSTRUCTION_PROVIDER = {
  id: "rea-reconstruction-verifier",
  name: "REA reconstruction verifier",
  version: "1",
} as const;
