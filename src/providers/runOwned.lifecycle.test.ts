import { describe, expect, it } from "vitest";

import { AnalysisCleanupLease } from "../artifacts/AnalysisCleanupLease.js";
import {
  primaryAnalysisError,
  type AnalysisError,
} from "../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisProtocolError,
} from "../domain/analysisErrorCore.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { releaseOwnedCleanup } from "../../tests/support/cleanupRelease.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  finalizedResult,
  runOwned,
  type CompletedValueRecord,
  type CompletedValueReplacement,
  type Finalized,
} from "./runOwned.js";

/**
 * The lifecycle scenarios of docs/development/testing.md#lifecycle-regressions
 * that `runOwned` owns, run over every adopter shape below. A provider that
 * finalizes through `runOwned` inherits these semantics; its own tests cover
 * only how its work and close reach this primitive.
 */

interface Completed {
  readonly count: number;
}

const completed: Completed = { count: 3 };
const reason = { caller: "stop" };

/** How an adopter declares the value an error must keep, and how it publishes. */
interface AdopterFixture {
  readonly name: string;
  readonly record: CompletedValueRecord<Completed>;
  /** Asserts that an error replacing the completed value kept it. */
  readonly kept: (
    error: AnalysisError,
    replacedBy: CompletedValueReplacement,
  ) => void;
  readonly publishes: boolean;
  /** Close releases an exact lease instead of throwing a typed producer error. */
  readonly lease: boolean;
}

const partialRecord: CompletedValueRecord<Completed> = {
  partial: (value, replacedBy) => ({
    kind: "retained-evidence",
    evidence_id: `counted-${String(value.count)}-${replacedBy}`,
  }),
};
const keptPartial = (
  error: AnalysisError,
  replacedBy: CompletedValueReplacement,
) =>
  expect(error.partialObservation).toEqual({
    kind: "retained-evidence",
    evidence_id: `counted-3-${replacedBy}`,
  });
const diagnosticsRecord: CompletedValueRecord<Completed> = {
  diagnostics: (value, replacedBy) => ({
    completed_count: value.count,
    replaced_by: replacedBy,
  }),
};
const keptDiagnostics = (
  error: AnalysisError,
  replacedBy: CompletedValueReplacement,
) => {
  expect(error.partialObservation).toBeUndefined();
  expect(error.diagnostics).toMatchObject({
    completed_count: 3,
    replaced_by: replacedBy,
  });
};

const adopters: readonly AdopterFixture[] = [
  {
    // apktool, ADB, tshark and sigrok one-shot readers.
    name: "one-shot reader keeping a partial observation through a lease",
    record: partialRecord,
    kept: keptPartial,
    publishes: false,
    lease: true,
  },
  {
    // Ghidra profile, signature binding and LLDB call tracing.
    name: "one-shot reader keeping a non-observation value as diagnostics",
    record: diagnosticsRecord,
    kept: keptDiagnostics,
    publishes: false,
    lease: false,
  },
  {
    name: "publishing writer keeping a partial observation",
    record: partialRecord,
    kept: keptPartial,
    publishes: true,
    lease: false,
  },
  {
    // Evidence bundle export.
    name: "publishing writer keeping diagnostics through a lease",
    record: diagnosticsRecord,
    kept: keptDiagnostics,
    publishes: true,
    lease: true,
  },
];

interface ScenarioControl {
  /** The work's own result; `abort` cancels after the workload exits. */
  readonly work: "completes" | "fails" | "throws" | "completes-then-abort";
  /** Cancellation arrives during final cleanup. */
  readonly abortDuringClose?: true;
  readonly cleanupFails?: true;
  readonly publicationFails?: true;
}

interface ScenarioRun {
  readonly finalized: Finalized<Completed>;
  readonly commits: readonly Completed[];
  readonly primary: AnalysisProtocolError;
  /** Lets the cleanup owner confirm release, as a retry would. */
  readonly recoverCleanup: () => Promise<void>;
}

const run = async (
  adopter: AdopterFixture,
  control: ScenarioControl,
): Promise<ScenarioRun> => {
  const controller = new AbortController();
  const primary = new AnalysisProtocolError("fixture failure");
  const commits: Completed[] = [];
  let releaseAttempts = 0;
  const lease = new AnalysisCleanupLease(async () => {
    releaseAttempts += 1;
    if (control.cleanupFails === true && releaseAttempts === 1)
      throw new Error("root removal denied");
  }, ["/owned/root"]);
  const typedCleanup = new ProviderCleanupError("fixture", ["/owned/root"], {
    reason: "still owned",
  });
  const work = async (): Promise<Result<Completed, AnalysisError>> => {
    switch (control.work) {
      case "completes":
        return ok(completed);
      case "completes-then-abort":
        controller.abort(reason);
        return ok(completed);
      case "fails":
        return err(primary);
      case "throws":
        throw new Error("unexpected");
    }
  };
  const finalized = await runOwned(work, {
    providerId: "fixture",
    operation: "fixture_operation",
    signal: controller.signal,
    ...adopter.record,
    ...(adopter.lease ? { cleanupLeases: [lease] } : {}),
    close: async () => {
      if (control.abortDuringClose === true) controller.abort(reason);
      if (adopter.lease) await lease.release();
      else if (control.cleanupFails === true) throw typedCleanup;
    },
    ...(adopter.publishes
      ? {
          commit: async (value: Completed) => {
            commits.push(value);
            if (control.publicationFails === true)
              throw new Error("publication failed");
          },
        }
      : {}),
  });
  return {
    finalized,
    commits,
    primary,
    recoverCleanup: async () => {
      if (adopter.lease) await lease.release();
      else releaseOwnedCleanup(typedCleanup);
    },
  };
};

const failure = (finalized: Finalized<Completed>): AnalysisError => {
  const result = finalizedResult(finalized);
  if (result.ok) throw new Error(`expected an error, got ${finalized.kind}`);
  return result.error;
};

const expectCancelledBy = (error: AnalysisError) => {
  const cancellation = primaryAnalysisError(error);
  expect(cancellation).toBeInstanceOf(AnalysisCancelledError);
  expect(cancellation.cause).toBe(reason);
};

interface LifecycleScenario {
  /** The docs/development/testing.md lifecycle row this scenario covers. */
  readonly row: string;
  readonly name: string;
  readonly control: ScenarioControl;
  readonly applies?: (adopter: AdopterFixture) => boolean;
  readonly expect: (adopter: AdopterFixture, run: ScenarioRun) => Promise<void>;
}

const scenarios: readonly LifecycleScenario[] = [
  {
    row: "Cancellation arrives after workload exit (non-aborted control)",
    name: "completes when cleanup is released and no cancellation arrives",
    control: { work: "completes" },
    expect: async (adopter, { finalized, commits }) => {
      expect(finalized).toEqual({ kind: "completed", value: completed });
      expect(commits).toEqual(adopter.publishes ? [completed] : []);
    },
  },
  {
    row: "Cancellation arrives after workload exit, during result reads or temporary-root removal",
    name: "cancellation after workload exit, before the commit cutoff",
    control: { work: "completes-then-abort" },
    expect: async (adopter, { finalized, commits }) => {
      expect(commits).toEqual([]);
      expect(finalized).toMatchObject({
        kind: "cancelled",
        cleanup: { kind: "released" },
      });
      const error = failure(finalized);
      expectCancelledBy(error);
      adopter.kept(error, "cancellation");
    },
  },
  {
    row: "Cancellation arrives after workload exit, during result reads or temporary-root removal",
    name: "cancellation during final cleanup",
    control: { work: "completes", abortDuringClose: true },
    expect: async (adopter, { finalized, commits }) => {
      if (adopter.publishes) {
        // Publication precedes close, so the receipt stands.
        expect(commits).toEqual([completed]);
        expect(finalized).toEqual({
          kind: "completed",
          value: completed,
          lateCancellation: reason,
        });
        return;
      }
      expect(finalized).toMatchObject({
        kind: "cancelled",
        cleanup: { kind: "released" },
      });
      const error = failure(finalized);
      expectCancelledBy(error);
      adopter.kept(error, "cancellation");
    },
  },
  {
    row: "Cleanup fails after success or primary failure",
    name: "cleanup fails after success, then its owner confirms release",
    control: { work: "completes", cleanupFails: true },
    expect: async (adopter, { finalized, commits, recoverCleanup }) => {
      expect(commits).toEqual(adopter.publishes ? [completed] : []);
      expect(finalized.kind).toBe("completed-cleanup-retained");
      const error = failure(finalized);
      // The documented one-shot contract: an error that keeps the value.
      expect(projectAnalysisError(error).code).toBe("cleanup_incomplete");
      expect(error.cleanupIncomplete).toBe(true);
      expect(error.cleanupResources).toEqual(["/owned/root"]);
      adopter.kept(error, "failure");
      await recoverCleanup();
      expect(error.cleanupIncomplete).toBe(false);
    },
  },
  {
    row: "Cleanup fails after success or primary failure",
    name: "cleanup fails after a primary failure, then its owner confirms release",
    control: { work: "fails", cleanupFails: true },
    expect: async (
      _adopter,
      { finalized, commits, primary, recoverCleanup },
    ) => {
      expect(commits).toEqual([]);
      expect(finalized).toMatchObject({
        kind: "failed",
        cleanup: { kind: "retained" },
      });
      const error = failure(finalized);
      expect(primaryAnalysisError(error)).toBe(primary);
      expect(error.cleanupIncomplete).toBe(true);
      await recoverCleanup();
      expect(error.cleanupIncomplete).toBe(false);
    },
  },
  {
    row: "Cancellation arrives after workload exit, during result reads or temporary-root removal",
    name: "a recorded failure keeps precedence over cancellation during final cleanup",
    control: { work: "fails", abortDuringClose: true },
    expect: async (_adopter, { finalized, primary }) => {
      expect(finalized).toMatchObject({
        kind: "failed",
        cleanup: { kind: "released" },
      });
      expect(primaryAnalysisError(failure(finalized))).toBe(primary);
      expect(primary.secondaryFailures).toEqual([
        expect.objectContaining({
          _tag: "AnalysisCancelledError",
          cause: reason,
        }),
      ]);
    },
  },
  {
    row: "Cancellation arrives after workload exit, during result reads or temporary-root removal",
    name: "cancellation during final cleanup that also fails",
    control: { work: "completes", abortDuringClose: true, cleanupFails: true },
    expect: async (adopter, { finalized, recoverCleanup }) => {
      const error = failure(finalized);
      expect(error.cleanupIncomplete).toBe(true);
      if (adopter.publishes) {
        expect(finalized.kind).toBe("completed-cleanup-retained");
        adopter.kept(error, "failure");
      } else {
        expect(finalized).toMatchObject({
          kind: "cancelled",
          cleanup: { kind: "retained" },
        });
        expectCancelledBy(error);
      }
      await recoverCleanup();
      expect(error.cleanupIncomplete).toBe(false);
    },
  },
  {
    row: "Cancellation arrives after workload exit (publication outcome after commit)",
    name: "publication fails and keeps the completed value",
    control: { work: "completes", publicationFails: true },
    applies: (adopter) => adopter.publishes,
    expect: async (adopter, { finalized, commits }) => {
      expect(commits).toEqual([completed]);
      expect(finalized).toMatchObject({
        kind: "failed",
        cleanup: { kind: "released" },
      });
      adopter.kept(failure(finalized), "failure");
    },
  },
  {
    row: "Launch returns an error (thrown work)",
    name: "types a thrown work failure as a provider adapter failure",
    control: { work: "throws" },
    expect: async (_adopter, { finalized, commits }) => {
      expect(commits).toEqual([]);
      expect(finalized.kind).toBe("failed");
      expect(failure(finalized)._tag).toBe("ProviderAdapterError");
    },
  },
];

describe.each(adopters)("runOwned lifecycle: $name", (adopter) => {
  it.each(scenarios.filter((scenario) => scenario.applies?.(adopter) ?? true))(
    "$name",
    async (scenario) => {
      await scenario.expect(adopter, await run(adopter, scenario.control));
    },
  );
});
