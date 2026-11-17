import { afterAll } from "vitest";
import { withArtifactResourceScope } from "../fixtures/artifactInventory.js";
import {
  analyzeJavaScriptApplication as analyzeOwned,
  type JavaScriptApplicationOptions,
} from "../../src/application/javascript/JavaScriptApplicationService.js";
import { reconstructJavaScriptArtifact as reconstructOwned } from "../../src/application/javascript/JavaScriptArtifactReconstruction.js";
import { analyzeJavaScriptApplicationInputSchema } from "../../src/domain/javascript/javascriptApplicationAnalysis.js";
import type { ProgressReporter } from "../../src/ports/ProgressReporter.js";
import { javascriptSourceAnalysis } from "../../src/composition/javascriptSourceAnalysis.js";
import { readJavaScriptArtifactFiles as readOwned } from "../../src/artifacts/javascript/JavaScriptArtifactFiles.js";
import {
  ArtifactReaderFailure,
  ArtifactResourceScope,
  type ArtifactReader,
} from "../../src/resources/index.js";
import type { ArtifactInventorySnapshot } from "../../src/domain/artifactInventorySnapshot.js";

let fileScope: ArtifactResourceScope | undefined;
let fileCleanupRegistered = false;
let fileQueue: Promise<void> = Promise.resolve();

const ensureFileScope = (): ArtifactResourceScope => {
  if (!fileCleanupRegistered) {
    fileCleanupRegistered = true;
    afterAll(async () => {
      const scope = fileScope;
      fileScope = undefined;
      await scope?.close();
    });
  }
  fileScope ??= new ArtifactResourceScope();
  return fileScope;
};

/**
 * Reuse one parked JavaScript worker per test file for uncancelled analyses,
 * matching production CLI/MCP session reuse while isolating cleanup failures.
 */
const withReusableJavaScriptScope = <T>(
  operation: (scope: ArtifactResourceScope) => Promise<T>,
): Promise<T> => {
  const run = async (): Promise<T> => {
    const scope = ensureFileScope();
    let outcome:
      | { readonly kind: "completed"; readonly value: T }
      | { readonly kind: "failed"; readonly cause: unknown };
    try {
      outcome = { kind: "completed", value: await operation(scope) };
    } catch (cause: unknown) {
      outcome = { kind: "failed", cause };
    }
    if (outcome.kind === "failed" || scope.hasPending) {
      if (fileScope === scope) fileScope = undefined;
      try {
        await scope.close();
      } catch (cleanupCause: unknown) {
        if (outcome.kind === "failed")
          throw ArtifactReaderFailure.withCleanup(
            outcome.cause,
            ArtifactReaderFailure.cleanupObservation(
              cleanupCause,
              "artifact resources",
            ),
          );
        throw cleanupCause;
      }
    }
    if (outcome.kind === "failed") throw outcome.cause;
    return outcome.value;
  };
  const scheduled = fileQueue.then(run);
  fileQueue = scheduled.then(
    () => undefined,
    () => undefined,
  );
  return scheduled;
};

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
  options: Omit<JavaScriptApplicationOptions, "sourceAnalysis"> = {},
) =>
  options.signal !== undefined
    ? withArtifactResourceScope((scope) =>
        analyzeOwned(input, scope, {
          sourceAnalysis: javascriptSourceAnalysis,
          ...options,
        }),
      )
    : withReusableJavaScriptScope((scope) =>
        analyzeOwned(input, scope, {
          sourceAnalysis: javascriptSourceAnalysis,
          ...options,
        }),
      );

/** Reconstruct a fixture with an awaited, test-owned artifact scope. */
export const reconstructJavaScriptArtifact = (
  rawInput: unknown,
  signal?: AbortSignal,
  progress?: ProgressReporter,
) =>
  signal !== undefined
    ? withArtifactResourceScope((scope) =>
        reconstructOwned(
          analyzeJavaScriptApplicationInputSchema.parse(rawInput),
          scope,
          javascriptSourceAnalysis,
          signal,
          progress,
        ),
      )
    : withReusableJavaScriptScope((scope) =>
        reconstructOwned(
          analyzeJavaScriptApplicationInputSchema.parse(rawInput),
          scope,
          javascriptSourceAnalysis,
          signal,
          progress,
        ),
      );
