import { expect, it } from "vitest";
import { withVerifierCleanup } from "../../scripts/lib/verifier-cleanup.mjs";
import {
  cancelDuringCleanup,
  controlledCleanup,
  phaseGate,
  settledCause,
} from "../../tests/support/lifecycleHarness.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
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
