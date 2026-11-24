import { stat } from "node:fs/promises";

import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { JsonValue } from "../../domain/jsonValue.js";
import { err, ok, type Result } from "../../domain/result.js";
import { AnalysisOutputError } from "../../domain/analysisErrorCore.js";
import {
  withEvidenceCallerInputPath,
  type Evidence,
} from "../../domain/evidence.js";
import type { ArtifactPathSource } from "./ArtifactComparisonEvidence.js";
import type {
  AnalysisExecution,
  ExecutionOptions,
} from "../../ports/AnalysisProvider.js";
import type { InspectArtifactDirectory } from "../../ports/artifacts/ArtifactDirectoryInspectionPort.js";
import type { DirectAnalysisDependencies } from "../DirectAnalysisDependencies.js";
import {
  managedAnalysisCleanupFailure,
  withSessionCleanup,
} from "../DirectAnalysisCleanup.js";

/** The owners a path-selected `inspect_artifact` runs with. */
export interface ArtifactPathInspectionDependencies {
  readonly inspectArtifactDirectory: InspectArtifactDirectory;
  readonly createArtifactBinarySession: DirectAnalysisDependencies["createArtifactBinarySession"];
}

/**
 * Whether a selected path names a directory, which `inspect_artifact`
 * inventories as a tree instead of opening as a session target. A path that
 * cannot be read is left to target admission, which owns its refusal.
 */
export const selectsArtifactDirectory = (path: string): Promise<boolean> =>
  stat(path).then(
    (metadata) => metadata.isDirectory(),
    () => false,
  );

/**
 * Inspect the artifact at a caller-selected path, independently of any open
 * session target: a directory is inventoried as a tree, and any other path
 * is admitted as a target in its own artifact-only session that closes
 * before this returns.
 */
export const executeArtifactPathInspection = async (
  dependencies: ArtifactPathInspectionDependencies,
  path: string,
  parameters: Readonly<Record<string, JsonValue>>,
  options: ExecutionOptions = {},
): Promise<Result<AnalysisExecution, AnalysisError>> => {
  if (await selectsArtifactDirectory(path))
    return dependencies.inspectArtifactDirectory(path, parameters, options);
  const session = await dependencies.createArtifactBinarySession();
  return withSessionCleanup(
    session,
    async () => {
      const opened = await session.open(
        path,
        options.signal === undefined ? {} : { signal: options.signal },
      );
      if (!opened.ok) return opened;
      return session.execute("inspect_artifact", parameters, options);
    },
    managedAnalysisCleanupFailure,
  );
};

/**
 * Inventory a comparison side's path in place and return its complete
 * inventory Evidence, the record the comparison cites.
 */
export const inventoryArtifactPath = async (
  dependencies: ArtifactPathInspectionDependencies,
  source: ArtifactPathSource,
  signal: AbortSignal | undefined,
): Promise<Result<Evidence, AnalysisError>> => {
  const execution = await executeArtifactPathInspection(
    dependencies,
    source.path,
    { integrity_policy: source.integrity_policy },
    signal === undefined ? {} : { signal },
  );
  if (!execution.ok) return execution;
  const inventory = execution.value.sourceEvidence?.find(
    (evidence) => evidence.operation === "inventory_artifact",
  );
  return inventory === undefined
    ? err(
        new AnalysisOutputError(
          "compare_artifacts",
          "Artifact inspection returned no inventory Evidence.",
        ),
      )
    : ok(withEvidenceCallerInputPath(inventory, source.path));
};
