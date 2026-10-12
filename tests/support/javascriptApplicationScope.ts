import { withArtifactResourceScope } from "../fixtures/artifactInventory.js";
import type { ExecutionOptions } from "../../src/application/AnalysisProvider.js";
import { analyzeJavaScriptApplication as analyzeOwned } from "../../src/application/javascript/JavaScriptApplicationService.js";
import { reconstructJavaScriptArtifact as reconstructOwned } from "../../src/application/javascript/JavaScriptArtifactReconstruction.js";
import type { ProgressReporter } from "../../src/application/ProgressReporter.js";
import { readJavaScriptArtifactFiles as readOwned } from "../../src/artifacts/javascript/JavaScriptArtifactFiles.js";
import type { ArtifactReader } from "../../src/artifacts/ArtifactReader.js";
import type { ArtifactInventorySnapshot } from "../../src/domain/artifactInventorySnapshot.js";

/** Read a fixture's nested containers with an awaited cleanup owner. */
export const readJavaScriptArtifactFiles = (
  reader: ArtifactReader,
  snapshot: ArtifactInventorySnapshot,
  signal?: AbortSignal,
  sourcePaths?: readonly string[],
) =>
  withArtifactResourceScope((scope) =>
    readOwned(reader, snapshot, scope, signal, sourcePaths),
  );

/** Run a JavaScript analysis with an awaited, test-owned artifact scope. */
export const analyzeJavaScriptApplication = (
  input: unknown,
  options: ExecutionOptions = {},
) => withArtifactResourceScope((scope) => analyzeOwned(input, scope, options));

/** Reconstruct a fixture with an awaited, test-owned artifact scope. */
export const reconstructJavaScriptArtifact = (
  rawInput: unknown,
  signal?: AbortSignal,
  progress?: ProgressReporter,
) =>
  withArtifactResourceScope((scope) =>
    reconstructOwned(rawInput, scope, signal, progress),
  );
