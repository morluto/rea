import type { AnalysisOperationPort } from "../ports/AnalysisProvider.js";
import type { ManagedBinarySessionPort } from "../application/binary/BinarySessionPort.js";
import { runManagedProviderExecution } from "../application/DirectAnalysis.js";
import { isManagedToolName } from "../contracts/managed/managedToolContracts.js";
import { artifactExtractionInputSchema } from "../contracts/artifactToolContracts.js";
import { createArtifactExtractionDestination } from "../application/artifacts/ArtifactExtractionDestination.js";
import {
  executeArtifactPathInspection,
  type ArtifactPathInspectionDependencies,
} from "../application/artifacts/ArtifactPathInspection.js";
import { AnalysisInputError } from "../domain/analysisErrorCore.js";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { err } from "../domain/result.js";
import type { ProviderOperation } from "./providerOperationToolHandler.js";

/**
 * Route managed PE/CLI operations to the execution-free managed reader. A
 * call without `path` reads the managed file last selected through this
 * server, else the active target when it is a managed PE; the selection
 * lasts as long as the returned router.
 */
export const managedAnalysisForAdmission = (
  activeTarget: (() => BinaryTarget | undefined) | undefined,
  createManagedBinarySession: () =>
    | ManagedBinarySessionPort
    | Promise<ManagedBinarySessionPort>,
): ((analysis: AnalysisOperationPort) => AnalysisOperationPort) => {
  let selectedManagedPath: string | undefined;
  return (analysis) => ({
    execute: async (operation, parameters, executionOptions) => {
      if (!isManagedToolName(operation))
        return analysis.execute(operation, parameters, executionOptions);
      const requestedPath = parameters.path;
      const target = activeTarget?.();
      const path =
        typeof requestedPath === "string"
          ? requestedPath
          : (selectedManagedPath ??
            (target?.format === "pe" && target.managed
              ? target.path
              : undefined));
      if (path === undefined)
        return err(
          new AnalysisInputError(operation, undefined, [
            {
              path: ["path"],
              reason: "missing_argument",
              message:
                "Provide a managed PE/CLI path or first select one with inspect_managed_artifact.",
            },
          ]),
        );
      const execution = await runManagedProviderExecution(
        { createManagedBinarySession },
        path,
        operation,
        executionOptions?.signal,
        parameters,
      );
      if (execution.ok && typeof requestedPath === "string")
        selectedManagedPath = requestedPath;
      return execution;
    },
  });
};

/**
 * Route an `inspect_artifact` call that names a path to the path's own
 * inspection, independently of the open target; a call without one keeps
 * inspecting the open target. The path is a selection, not an inventory
 * parameter, so the provider receives the remaining fields.
 */
export const artifactAnalysisForAdmission =
  (
    createPathInspection: () => Promise<ArtifactPathInspectionDependencies>,
  ): ((analysis: AnalysisOperationPort) => AnalysisOperationPort) =>
  (analysis) => ({
    execute: async (operation, parameters, executionOptions) => {
      const { path, ...inventoryParameters } = parameters;
      if (operation !== "inspect_artifact" || typeof path !== "string")
        return analysis.execute(operation, parameters, executionOptions);
      return executeArtifactPathInspection(
        await createPathInspection(),
        path,
        inventoryParameters,
        executionOptions,
        analysis.resourceScope,
      );
    },
  });

/** Extraction writes under a destination REA creates for the caller's root. */
export const artifactExecutionParameters = (
  operation: ProviderOperation,
  parameters: Readonly<Record<string, JsonValue>>,
): Readonly<Record<string, JsonValue>> => {
  if (operation !== "extract_artifact") return parameters;
  const execution = artifactExtractionInputSchema
    .omit({ detail: true })
    .parse(parameters);
  return {
    ...execution,
    output_root: createArtifactExtractionDestination(execution.output_root),
  };
};
