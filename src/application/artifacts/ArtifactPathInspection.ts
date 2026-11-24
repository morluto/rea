import { stat } from "node:fs/promises";

import { absoluteCallerPath } from "../../filesystem/callerPath.js";

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
  RetainedResourceScope,
} from "../../ports/AnalysisProvider.js";
import type { ArtifactResourceScope } from "../../resources/index.js";
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
 * The absolute directory a selected path names, resolved against the
 * caller's working directory as target admission resolves a file, or
 * undefined when it names no directory. `inspect_artifact` inventories that
 * directory as a tree instead of opening it as a session target; a path that
 * cannot be read is left to target admission, which owns its refusal.
 */
export const selectedArtifactDirectory = async (
  path: string,
): Promise<string | undefined> => {
  const absolute = absoluteCallerPath(path);
  return stat(absolute).then(
    (metadata) => (metadata.isDirectory() ? absolute : undefined),
    () => undefined,
  );
};

/**
 * Inspect the artifact at a caller-selected path, independently of any open
 * session target: a directory is inventoried as a tree, and any other path
 * is admitted as a target in its own artifact-only session that closes
 * before this returns. Whatever could not be released stays in `retained`,
 * the caller's lifetime, so closing that lifetime retries it.
 */
export const executeArtifactPathInspection = async (
  dependencies: ArtifactPathInspectionDependencies,
  path: string,
  parameters: Readonly<Record<string, JsonValue>>,
  options: ExecutionOptions = {},
  retained?: RetainedResourceScope,
): Promise<Result<AnalysisExecution, AnalysisError>> => {
  const directory = await selectedArtifactDirectory(path);
  if (directory !== undefined)
    return dependencies.inspectArtifactDirectory(
      directory,
      parameters,
      options,
      retained,
    );
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
    (value, error) => {
      retained?.retain(
        {
          close: async () => {
            const closed = await session.close();
            if (!closed.ok) throw closed.error;
          },
          cleanupResources: error.cleanupResources,
        },
        `artifact inspection session for ${path}`,
      );
      return managedAnalysisCleanupFailure(value, error);
    },
  );
};

/** Keep an inspection's failed cleanup in an artifact resource scope. */
export const retainedInArtifactScope = (
  scope: ArtifactResourceScope,
): RetainedResourceScope => ({
  retain: (owner, resource) =>
    scope.retain({
      kind: "lease",
      resource,
      lease: { release: () => owner.close() },
    }),
  run: (operation) => scope.run(operation),
});

/**
 * Inventory a comparison side's path in place and return its complete
 * inventory Evidence, the record the comparison cites.
 */
export const inventoryArtifactPath = async (
  dependencies: ArtifactPathInspectionDependencies,
  source: ArtifactPathSource,
  signal: AbortSignal | undefined,
  retained?: RetainedResourceScope,
): Promise<Result<Evidence, AnalysisError>> => {
  const execution = await executeArtifactPathInspection(
    dependencies,
    source.path,
    { integrity_policy: source.integrity_policy },
    signal === undefined ? {} : { signal },
    retained,
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
