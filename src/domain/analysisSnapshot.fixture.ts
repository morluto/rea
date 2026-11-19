import { createAnalysisProfile } from "./analysisProfile.js";
import type { BinaryTarget } from "./binaryTargetTypes.js";
import { evidenceSubject, type EvidenceSubjectTarget } from "./evidence.js";
import { unknownTarget } from "./targetIdentity.js";

/** Immutable target shared by analysis-snapshot contract tests. */
export const ANALYSIS_SNAPSHOT_TARGET: BinaryTarget = {
  path: "/tmp/app",
  sha256: "a".repeat(64),
  kind: "executable",
  format: "mach-o",
  architecture: "arm64",
  availableArchitectures: ["arm64"],
};

/** Provider identity shared by analysis-snapshot contract tests. */
export const ANALYSIS_SNAPSHOT_PROVIDER = {
  id: "fixture",
  name: "Fixture",
  version: "1",
} as const;

/** Exact analysis profile shared by analysis-snapshot contract tests. */
export const ANALYSIS_SNAPSHOT_PROFILE = createAnalysisProfile(
  ANALYSIS_SNAPSHOT_PROVIDER,
  { loader: "mach-o-arm64" },
);

/** A provider execution as a snapshot entry records it: with its Evidence subject. */
export const snapshotExecution = <
  Execution extends { readonly subject?: EvidenceSubjectTarget | null },
>(
  execution: Execution,
) => ({
  ...execution,
  subject: evidenceSubject(execution.subject ?? unknownTarget("not-observed")),
});
