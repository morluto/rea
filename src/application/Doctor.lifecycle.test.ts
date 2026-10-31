import { expect, it } from "vitest";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { createDoctorHostFixture } from "./Doctor.fixture.js";
import {
  runDoctorOwned,
  systemDoctorHost,
  type DoctorProviderInspection,
} from "./Doctor.js";

it("joins a late provider inspection and retries only its unresolved cleanup owners", async () => {
  let enter!: (signal: AbortSignal) => void;
  const entered = new Promise<AbortSignal>((resolve) => {
    enter = resolve;
  });
  let handOff!: () => void;
  const handoff = new Promise<void>((resolve) => {
    handOff = resolve;
  });
  let finish!: () => void;
  const finishing = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let denied = true;
  let closed = false;
  const closes = { successful: 0, refused: 0 };
  const host = systemDoctorHost({
    environment: {},
    providerInspections: async (owner, signal) => {
      enter(signal);
      await handoff;
      owner.retain(
        {
          close: async () => {
            closes.successful++;
            await finishing;
          },
        },
        "successful-prerequisite",
      );
      owner.retain(
        {
          close: async () => {
            closes.refused++;
            if (denied) throw new Error("controlled cleanup refusal");
          },
        },
        "refused-prerequisite",
      );
      return [];
    },
  });
  const inspection = host.providerInspections!();
  const signal = await entered;
  const closing = host.close!().then(
    () => {
      closed = true;
      return undefined;
    },
    (cause: unknown) => {
      closed = true;
      return cause;
    },
  );
  try {
    expect(signal.aborted).toBe(true);
    expect(closed).toBe(false);
    handOff();
    await inspection;
    expect(closed).toBe(false);
    finish();
    const failure = await closing;
    if (!(failure instanceof AnalysisError))
      throw new Error("Expected attributed cleanup failure");
    expect(failure.cleanupResources).toEqual(["refused-prerequisite"]);
    expect(failure.cleanupIncomplete).toBe(true);
    expect(closes).toEqual({ successful: 1, refused: 1 });
    denied = false;
    await host.close!();
    expect(failure.cleanupIncomplete).toBe(false);
    expect(closes).toEqual({ successful: 1, refused: 2 });
    await expect(host.providerInspections!()).rejects.toThrow(
      "scope is closed",
    );
  } finally {
    denied = false;
    handOff();
    finish();
    await inspection;
    await closing;
    await host.close!();
  }
});

it("retains a completed healthy report when cancellation arrives during final cleanup", async () => {
  const controller = new AbortController();
  const reason = { request: "cancel final doctor cleanup" };
  await expect(
    runDoctorOwned(
      undefined,
      createDoctorHostFixture({
        signal: controller.signal,
        close: async () => {
          controller.abort(reason);
          return undefined;
        },
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
        close: async () => {
          controller.abort(physical);
          return undefined;
        },
      }),
    ),
  ).rejects.toBe(physical);
  expect(physical.cause).toBeUndefined();
});

it.each([false, true])(
  "retains completed provider inspections through failed cleanup and retry (late cancellation: %s)",
  async (cancelDuringCleanup) => {
    const controller = new AbortController();
    const reason = { request: "cancel between provider groups" };
    const inspections = [
      providerInspection("ghidra", true),
      providerInspection("kuna", false),
    ];
    let denied = true;
    let laterGroups = 0;
    const closes = { successful: 0, refused: 0 };
    const host = systemDoctorHost({
      environment: {},
      signal: controller.signal,
      providerInspections: [
        async () => [inspections[0]!],
        async (owner) => {
          owner.retain(
            {
              close: async () => {
                closes.successful++;
              },
            },
            "successful-provider-command",
          );
          owner.retain(
            {
              close: async () => {
                closes.refused++;
                if (cancelDuringCleanup) controller.abort(reason);
                if (denied) throw new Error("controlled cleanup refusal");
              },
            },
            "refused-provider-command",
          );
          return [inspections[1]!];
        },
        async () => {
          laterGroups++;
          return [providerInspection("binwalk", true)];
        },
      ],
    });
    try {
      const failure: unknown = await runDoctorOwned(
        undefined,
        createDoctorHostFixture({
          signal: controller.signal,
          providerInspections: host.providerInspections!,
          close: host.close!,
        }),
      ).catch((cause: unknown) => cause);
      if (!(failure instanceof AnalysisError))
        throw new Error("Expected typed doctor cleanup failure");
      const retained = {
        provider_inspections: inspections,
        provider_inspection_groups: { completed: 2, total: 3 },
      };
      // Use the CLI's error projection and JSON encoding, including the outer
      // failed-close composition rather than only inspecting the inner error.
      expect(
        JSON.parse(JSON.stringify(projectAnalysisError(failure))),
      ).toMatchObject({
        code: "cleanup_incomplete",
        details: {
          resources: ["refused-provider-command"],
          diagnostics: {
            primary_error: { details: { diagnostics: retained } },
          },
        },
      });
      expect(laterGroups).toBe(0);
      expect(closes).toEqual({ successful: 1, refused: 2 });
      if (cancelDuringCleanup) expect(controller.signal.reason).toBe(reason);

      denied = false;
      await host.close!();
      expect(failure.cleanupIncomplete).toBe(false);
      expect(failure.cleanupResources).toEqual([]);
      expect(closes).toEqual({ successful: 1, refused: 3 });
      expect(
        JSON.parse(JSON.stringify(projectAnalysisError(failure))),
      ).toMatchObject({
        code: "execution_failure",
        details: { diagnostics: retained },
      });
      expect(laterGroups).toBe(0);
    } finally {
      denied = false;
      await host.close!();
    }
  },
);

it.each(["physical failure", "cancellation"] as const)(
  "preserves completed provider inspections and the original %s when a later group fails",
  async (kind) => {
    const controller = new AbortController();
    const reason = { request: "cancel doctor" };
    const primary =
      kind === "cancellation"
        ? new AnalysisCancelledError("doctor", { cause: reason })
        : new ProviderAdapterError("kuna", "doctor", {
            cause: new Error("controlled provider fault"),
            diagnostics: { reason: "controlled provider fault" },
            capturedOutput: {
              stdout: "probe output",
              stderr: "probe failure",
              truncated: false,
            },
          });
    const originalCause = primary.cause;
    const inspection = providerInspection("ghidra", true);
    let laterGroups = 0;
    const host = systemDoctorHost({
      environment: {},
      signal: controller.signal,
      providerInspections: [
        async () => [inspection],
        async () => {
          throw primary;
        },
        async () => {
          laterGroups++;
          return [];
        },
      ],
    });
    await expect(
      runDoctorOwned(
        undefined,
        createDoctorHostFixture({
          signal: controller.signal,
          providerInspections: host.providerInspections!,
          close: async () => {
            controller.abort(reason);
            return host.close!();
          },
        }),
      ),
    ).rejects.toBe(primary);
    expect(primary.cause).toBe(originalCause);
    expect(laterGroups).toBe(0);
    expect(
      JSON.parse(JSON.stringify(projectAnalysisError(primary))),
    ).toMatchObject({
      code: kind === "cancellation" ? "cancelled" : "execution_failure",
      details: {
        diagnostics: {
          ...(kind === "cancellation"
            ? {}
            : { reason: "controlled provider fault" }),
          provider_inspections: [inspection],
          provider_inspection_groups: { completed: 1, total: 3 },
        },
        ...(kind === "cancellation"
          ? {}
          : { captured_output: primary.capturedOutput }),
      },
    });
  },
);

const providerInspection = (
  id: string,
  healthy: boolean,
): DoctorProviderInspection => ({
  id,
  configured: true,
  available: healthy,
  providerVersion: `${id}-observed-version`,
  registrationEnvironment: {},
  checks: [
    {
      name: `${id}-readiness`,
      ok: healthy,
      code: healthy ? null : "controlled_probe_failure",
      detail: healthy
        ? "Observed ready provider"
        : "Observed failed provider probe",
      remediation: healthy ? null : "Repair the provider probe",
      classification: "runtime_failure",
      details: { output: `${id} captured output` },
    },
  ],
});
