import { expect, it } from "vitest";
import { withVerifierCleanup } from "../../scripts/lib/verifier-cleanup.mjs";
import {
  cancelDuringCleanup,
  controlledCleanup,
  phaseGate,
  settledCause,
} from "../../tests/support/lifecycleHarness.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import { cancelledBy } from "../domain/analysisErrorCore.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { createDoctorHostFixture } from "./Doctor.fixture.js";
import { runDoctorOwned, systemDoctorHost } from "./Doctor.js";

it("joins a late provider inspection and retries only its unresolved cleanup owners", async () => {
  // The inspection is still running when close starts, then hands over two
  // children with mixed cleanup outcomes; only the refused one is retried.
  const inspecting = phaseGate<AbortSignal>();
  const finishing = phaseGate();
  const successful = controlledCleanup();
  const refused = controlledCleanup({ refused: true });
  const host = systemDoctorHost({
    environment: {},
    providerInspections: async (owner, signal) => {
      await inspecting.hold(signal);
      owner.retain(
        { close: () => successful.close(() => finishing.hold()) },
        "successful-prerequisite",
      );
      owner.retain({ close: () => refused.close() }, "refused-prerequisite");
      return [];
    },
  });
  const inspection = host.providerInspections!([]);
  let closing: Promise<unknown> | undefined;
  let closed = false;
  await withVerifierCleanup(async () => {
    const signal = await inspecting.reached(inspection, "provider inspection");
    closing = settledCause(host.close!()).finally(() => {
      closed = true;
    });
    expect(signal.aborted).toBe(true);
    expect(closed).toBe(false);
    inspecting.release();
    await inspection;
    expect(closed).toBe(false);
    finishing.release();
    const failure = await closing;
    if (!(failure instanceof AnalysisError))
      throw new Error("Expected attributed cleanup failure");
    expect(failure.cleanupResources).toEqual(["refused-prerequisite"]);
    expect(failure.cleanupIncomplete).toBe(true);
    expect([successful.attempts, refused.attempts]).toEqual([1, 1]);
    refused.allow();
    await host.close!();
    expect(failure.cleanupIncomplete).toBe(false);
    expect([successful.attempts, refused.attempts]).toEqual([1, 2]);
    await expect(host.providerInspections!([])).rejects.toThrow(
      "scope is closed",
    );
  }, [
    () => {
      refused.allow();
      inspecting.release();
      finishing.release();
    },
    async () => {
      await inspection;
    },
    async () => {
      await closing;
    },
    () => host.close!(),
  ]);
});

it("retains a completed healthy report when cancellation arrives during final cleanup", async () => {
  const controller = new AbortController();
  const reason = { request: "cancel final doctor cleanup" };
  await expect(
    runDoctorOwned(
      undefined,
      createDoctorHostFixture({
        signal: controller.signal,
        close: cancelDuringCleanup(controller, reason),
      }),
    ),
  ).rejects.toMatchObject({
    _tag: "AnalysisCancelledError",
    cause: reason,
    diagnostics: { doctor_report: { healthy: true } },
  });
});

it("preserves an inspection-authored physical failure when final cleanup also observes cancellation", async () => {
  const controller = new AbortController();
  const physical = new ProviderAdapterError("ghidra", "doctor", {
    diagnostics: { reason: "controlled inspection fault" },
  });
  await expect(
    runDoctorOwned(
      undefined,
      createDoctorHostFixture({
        signal: controller.signal,
        providerInspections: async () => {
          throw physical;
        },
        close: cancelDuringCleanup(controller, physical),
      }),
    ),
  ).rejects.toBe(physical);
  expect(physical.cause).toBeUndefined();
});

it("joins concurrent sibling probes before closing and prefers physical failure over sibling cancellation", async () => {
  const controller = new AbortController();
  const siblingInFlight = phaseGate();
  const refusedCleanup = controlledCleanup({ refused: true });
  const physical = new ProviderAdapterError("jadx", "doctor", {
    diagnostics: { reason: "concurrent provider fault" },
  });
  let closeStarted = false;
  let siblingSettledBeforeClose = false;
  const ownedSystem = systemDoctorHost({
    signal: controller.signal,
    platform: "darwin",
    environment: {},
    providerInspections: async (owner) => {
      await siblingInFlight.hold();
      siblingSettledBeforeClose = !closeStarted;
      owner.retain(
        { close: () => refusedCleanup.close() },
        "sibling-prerequisite",
      );
      throw physical;
    },
  });
  const ownedHost = {
    ...ownedSystem,
    macosVersion: async () => {
      controller.abort({ request: "concurrent cancellation" });
      throw cancelledBy("doctor", controller.signal);
    },
    close: async () => {
      closeStarted = true;
      return ownedSystem.close!();
    },
  };
  const running = settledCause(runDoctorOwned(undefined, ownedHost));
  await withVerifierCleanup(async () => {
    await siblingInFlight.reached(running, "concurrent provider probe");
    expect(closeStarted).toBe(false);
    siblingInFlight.release();
    const failure = await running;
    expect(siblingSettledBeforeClose).toBe(true);
    if (!(failure instanceof AnalysisError))
      throw new Error("Expected attributed composite failure");
    expect(failure.cleanupResources).toEqual(["sibling-prerequisite"]);
    expect(failure.cleanupIncomplete).toBe(true);
    expect(failure.diagnostics).toMatchObject({
      primary_error: {
        details: {
          provider_id: "jadx",
          diagnostics: { reason: "concurrent provider fault" },
        },
      },
    });
    refusedCleanup.allow();
    await ownedHost.close();
    expect(failure.cleanupIncomplete).toBe(false);
  }, [
    () => {
      refusedCleanup.allow();
      siblingInFlight.release();
    },
    async () => {
      await running;
    },
    () => ownedHost.close(),
  ]);
});

it("does not deadlock when one concurrent probe retains failed cleanup while a peer enters another scoped read", async () => {
  const betweenReads = phaseGate();
  const refusedCleanup = controlledCleanup({ refused: true });
  let secondReadCompleted = false;
  const host = systemDoctorHost({
    platform: "darwin",
    environment: {},
    providerInspections: async (owner) => {
      const peerProbe = (async () => {
        await owner.run(async () => undefined);
        await betweenReads.hold();
        await owner.run(async () => {
          secondReadCompleted = true;
        });
      })();
      await owner.run(async () => {
        owner.retain(
          { close: () => refusedCleanup.close() },
          "ida-registration-handle",
        );
      });
      betweenReads.release();
      await peerProbe;
      return [];
    },
  });
  await withVerifierCleanup(async () => {
    await expect(host.providerInspections!([])).resolves.toEqual([]);
    expect(secondReadCompleted).toBe(true);
    const failure = await settledCause(host.close!());
    if (!(failure instanceof AnalysisError))
      throw new Error("Expected retained cleanup failure on close");
    expect(failure.cleanupResources).toEqual(["ida-registration-handle"]);
    expect(failure.cleanupIncomplete).toBe(true);
    refusedCleanup.allow();
    await host.close!();
    expect(failure.cleanupIncomplete).toBe(false);
  }, [
    () => {
      refusedCleanup.allow();
      betweenReads.release();
    },
    () => host.close!(),
  ]);
});
