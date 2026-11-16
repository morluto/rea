import { expect, it } from "vitest";
import {
  VerifierArtifactCleanupFailure,
  withVerifierArtifactScope,
} from "../../../scripts/lib/verifier-artifact-scope.mjs";
import type { ArtifactResourceScope } from "../../../src/resources/ArtifactResourceScope.js";
import { phaseGate } from "../../support/lifecycleHarness.js";

it("retains the exact scope for retry and preserves the operation failure", async () => {
  const primary = new Error("analysis failed");
  const cleanup = new Error("worker close failed");
  let attempts = 0;
  let scope: ArtifactResourceScope | undefined;
  let failure: unknown;
  try {
    await withVerifierArtifactScope(async (owner) => {
      scope = owner;
      owner.addCloseHook(async () => {
        if (++attempts === 1) throw cleanup;
      });
      throw primary;
    });
  } catch (cause) {
    failure = cause;
  }
  expect(failure).toBeInstanceOf(VerifierArtifactCleanupFailure);
  const aggregate = failure as VerifierArtifactCleanupFailure;
  expect(aggregate.errors).toEqual([primary, cleanup]);
  expect(aggregate.cause).toBe(primary);
  expect(aggregate.cleanupOwner).toBe(scope);
  await aggregate.cleanupOwner.close();
  expect(attempts).toBe(2);
});

it("retains cleanup authority when the operation succeeds", async () => {
  let attempts = 0;
  let failure: unknown;
  try {
    await withVerifierArtifactScope(async (scope) => {
      scope.addCloseHook(async () => {
        if (++attempts === 1) throw new Error("close failed");
      });
      return "result";
    });
  } catch (cause) {
    failure = cause;
  }
  expect(failure).toBeInstanceOf(VerifierArtifactCleanupFailure);
  const aggregate = failure as VerifierArtifactCleanupFailure;
  expect(aggregate.errors).toHaveLength(1);
  await aggregate.cleanupOwner.close();
  expect(attempts).toBe(2);
});

it("finishes every close hook when cancellation arrives during final cleanup", async () => {
  const controller = new AbortController();
  const cleanup = new Error("first close failed");
  const verifierArtifactCloseHook = phaseGate();
  const calls: string[] = [];
  let attempts = 0;
  const operation = withVerifierArtifactScope(async (scope) => {
    scope.addCloseHook(async () => {
      calls.push("first");
      if (++attempts === 1) {
        await verifierArtifactCloseHook.hold();
        if (controller.signal.aborted) throw cleanup;
      }
    });
    scope.addCloseHook(async () => {
      calls.push("second");
    });
    return "finished";
  });
  try {
    await verifierArtifactCloseHook.reached(
      operation,
      "verifier artifact close hook",
    );
    controller.abort();
  } finally {
    // Release and join the parked cleanup even when the boundary is missed.
    verifierArtifactCloseHook.release();
    await operation.catch(() => undefined);
  }
  let failure: unknown;
  try {
    await operation;
  } catch (cause) {
    failure = cause;
  }
  expect(controller.signal.aborted).toBe(true);
  expect(failure).toBeInstanceOf(VerifierArtifactCleanupFailure);
  expect(calls).toEqual(["first", "second"]);
  const aggregate = failure as VerifierArtifactCleanupFailure;
  expect(aggregate.errors).toEqual([cleanup]);
  await aggregate.cleanupOwner.close();
  expect(calls).toEqual(["first", "second", "first", "second"]);
});
