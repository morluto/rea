import { access } from "node:fs/promises";
import { expect, it } from "vitest";
import { ArtifactResourceScope } from "../../../src/artifacts/ArtifactResourceScope.js";
import { HopperDeadlineCleanup } from "../../../scripts/lib/hopper-deadline-cleanup.mjs";
import { awaitAcknowledgement } from "../../fixtures/lifecycleAcknowledgement.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it("retains the workspace and exact cleanup owner until failed profile cleanup succeeds", async () => {
  const workspace = await createTestTempDirectory(
    "rea-hopper-deadline-cleanup-",
  );
  const profile = new ArtifactResourceScope();
  const denial = new Error("profile close denied");
  let attempts = 0;
  profile.addCloseHook(async () => {
    if (++attempts === 1) throw denial;
  });
  const owner = new HopperDeadlineCleanup(workspace, profile);
  let failure: unknown;
  try {
    await owner.close();
  } catch (cause) {
    failure = cause;
  }
  expect(failure).toBeInstanceOf(AggregateError);
  expect(failure).toMatchObject({ cleanupOwner: owner, errors: [denial] });
  await expect(access(workspace)).resolves.toBeUndefined();
  await owner.close();
  expect(attempts).toBe(2);
  await expect(access(workspace)).rejects.toMatchObject({ code: "ENOENT" });
});

it("attempts both owners and retries them after cancellation during cleanup", async () => {
  const workspace = await createTestTempDirectory("rea-hopper-deadline-mixed-");
  const profile = new ArtifactResourceScope();
  const controller = new AbortController();
  const clientFailure = new Error("client close denied");
  const profileFailure = new Error("profile close interrupted");
  let release: (() => void) | undefined;
  let entered: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let profileAttempts = 0;
  profile.addCloseHook(async () => {
    if (++profileAttempts === 1) {
      entered?.();
      await gate;
      if (controller.signal.aborted) throw profileFailure;
    }
  });
  let clientAttempts = 0;
  const owner = new HopperDeadlineCleanup(workspace, profile);
  owner.setClient({
    close: async () =>
      ++clientAttempts === 1
        ? { ok: false, error: clientFailure }
        : { ok: true },
  });
  const first = owner.close();
  try {
    expect(owner.close()).toBe(first);
    await awaitAcknowledgement(started, first, "Hopper profile close hook");
    controller.abort();
  } finally {
    // Release and join the parked cleanup even when an assertion fails.
    release?.();
    await first.catch(() => undefined);
  }
  await expect(first).rejects.toMatchObject({
    cleanupOwner: owner,
    errors: [clientFailure, profileFailure],
  });
  await expect(access(workspace)).resolves.toBeUndefined();
  await owner.close();
  expect([clientAttempts, profileAttempts]).toEqual([2, 2]);
  await expect(access(workspace)).rejects.toMatchObject({ code: "ENOENT" });
});
