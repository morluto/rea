import { afterAll, expect } from "vitest";
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

interface FileJavaScriptScopeState {
  active: ArtifactResourceScope | undefined;
  readonly retained: Set<ArtifactResourceScope>;
  queue: Promise<void>;
  teardownRegistered: boolean;
}

const fileStates = new Map<string, FileJavaScriptScopeState>();

const closeScope = async (
  state: FileJavaScriptScopeState,
  scope: ArtifactResourceScope,
): Promise<void> => {
  await scope.close();
  state.retained.delete(scope);
};

const closeRetainedScopes = async (
  state: FileJavaScriptScopeState,
): Promise<void> => {
  const results = await Promise.allSettled(
    [...state.retained].map((scope) => closeScope(state, scope)),
  );
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, "JavaScript test scope cleanup failed");
};

/**
 * Resolve per-file state by current Vitest `testPath`, re-registering `afterAll`
 * for each test file even in `isolate: false` projects (`mcp-boundary`,
 * `cli-boundary`) that share module state across files.
 */
const ensureFileState = (
  testPath = expect.getState().testPath ?? "__default__",
  registerTeardown: (fn: () => Promise<void>) => void = afterAll,
): FileJavaScriptScopeState => {
  let state = fileStates.get(testPath);
  if (state === undefined) {
    state = {
      active: undefined,
      retained: new Set(),
      queue: Promise.resolve(),
      teardownRegistered: false,
    };
    fileStates.set(testPath, state);
  }
  if (!state.teardownRegistered) {
    state.teardownRegistered = true;
    const ownedState = state;
    registerTeardown(async () => {
      ownedState.teardownRegistered = false;
      ownedState.active = undefined;
      await closeRetainedScopes(ownedState);
      if (ownedState.retained.size === 0 && !ownedState.teardownRegistered)
        fileStates.delete(testPath);
    });
  }
  return state;
};

/**
 * Reuse one parked JavaScript worker per test file for uncancelled analyses,
 * matching production CLI/MCP session reuse while keeping any scope whose
 * cleanup failed in `state.retained` until a retry succeeds.
 */
export const withReusableJavaScriptScopeForTest = <T>(
  operation: (scope: ArtifactResourceScope) => Promise<T>,
  hooks?: {
    readonly testPath?: string;
    readonly registerTeardown?: (fn: () => Promise<void>) => void;
    readonly createScope?: () => ArtifactResourceScope;
  },
): Promise<T> => {
  const state = ensureFileState(hooks?.testPath, hooks?.registerTeardown);
  const run = async (): Promise<T> => {
    if (state.active === undefined && state.retained.size > 0) {
      // Finish any previously failed cleanup before starting a replacement worker.
      await closeRetainedScopes(state);
    }
    let scope = state.active;
    if (scope === undefined) {
      scope = hooks?.createScope?.() ?? new ArtifactResourceScope();
      state.retained.add(scope);
      state.active = scope;
    }
    let outcome:
      | { readonly kind: "completed"; readonly value: T }
      | { readonly kind: "failed"; readonly cause: unknown };
    try {
      outcome = { kind: "completed", value: await operation(scope) };
    } catch (cause: unknown) {
      outcome = { kind: "failed", cause };
    }
    if (outcome.kind === "failed" || scope.hasPending) {
      if (state.active === scope) state.active = undefined;
      try {
        await closeScope(state, scope);
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
  const scheduled = state.queue.then(run);
  state.queue = scheduled.then(
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
    : withReusableJavaScriptScopeForTest((scope) =>
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
    : withReusableJavaScriptScopeForTest((scope) =>
        reconstructOwned(
          analyzeJavaScriptApplicationInputSchema.parse(rawInput),
          scope,
          javascriptSourceAnalysis,
          signal,
          progress,
        ),
      );
