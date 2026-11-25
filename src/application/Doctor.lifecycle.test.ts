import type { DoctorProviderInspection } from "../ports/DoctorProviderInspection.js";
import { expect, it } from "vitest";
import { withVerifierCleanup } from "../../scripts/lib/verifier-cleanup.mjs";
import {
  cancelDuringCleanup,
  controlledCleanup,
  phaseGate,
  settledCause,
} from "../../tests/support/lifecycleHarness.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  cancelledBy,
  OwnerCancellation,
} from "../domain/analysisErrorCore.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { awaitAcknowledgement } from "../../tests/fixtures/lifecycleAcknowledgement.js";
import { createDoctorHostFixture } from "./Doctor.fixture.js";
import { runDoctorOwned, systemDoctorHost } from "./Doctor.js";
import type { DoctorProviderConfiguration } from "./Doctor.js";

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
    await expect(host.providerInspections!([])).rejects.toMatchObject({
      _tag: "AnalysisCancelledError",
      cause: OwnerCancellation.startupOwnerClosed,
      diagnostics: {
        provider_inspections: [],
        provider_inspection_groups: { completed: 0, total: 1 },
      },
    });
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

it("creates client-selected inspection groups afresh and drains cleanup between groups", async () => {
  const events: string[] = [];
  const selections: readonly string[][] = [["claude"], ["codex"]];
  let factories = 0;
  const host = systemDoctorHost({
    environment: {},
    providerInspectionGroups: (selectedClients) => {
      factories++;
      const selected = selectedClients[0]!;
      let cleaned = false;
      return [
        async (owner, _signal, clients) => {
          expect(clients).toBe(selectedClients);
          events.push(`inspect:${selected}`);
          owner.retain(
            {
              close: async () => {
                cleaned = true;
                events.push(`cleanup:${selected}`);
              },
            },
            `selected-registration:${selected}`,
          );
          return [providerInspection(selected, true)];
        },
        async (_owner, _signal, clients) => {
          expect(clients).toBe(selectedClients);
          expect(cleaned).toBe(true);
          events.push(`continue:${selected}`);
          return [];
        },
      ];
    },
  });
  try {
    for (const selection of selections)
      await expect(host.providerInspections!(selection)).resolves.toEqual([
        providerInspection(selection[0]!, true),
      ]);
    expect(factories).toBe(2);
    expect(events).toEqual([
      "inspect:claude",
      "cleanup:claude",
      "continue:claude",
      "inspect:codex",
      "cleanup:codex",
      "continue:codex",
    ]);
  } finally {
    await host.close!();
  }
});

it.each(["direct", "selected view"] as const)(
  "does not start queued configuration selection after host closure through the %s route",
  async (route) => {
    let selections = 0;
    let groups = 0;
    const host = systemDoctorHost({
      environment: {},
      selectProviderConfiguration: async () => {
        selections++;
        return { environment: {} };
      },
      providerInspections: async () => {
        groups++;
        return [];
      },
    });
    const inspecting =
      route === "direct"
        ? host.providerInspections!([])
        : host.forProviderDiagnostics!([]);
    const closing = host.close!();
    try {
      await expect(inspecting).rejects.toMatchObject({
        _tag: "AnalysisCancelledError",
        cause: OwnerCancellation.startupOwnerClosed,
      });
      expect(selections).toBe(0);
      expect(groups).toBe(0);
    } finally {
      await closing;
    }
  },
);

it.each(["direct", "selected view"] as const)(
  "drains selected-configuration cleanup before the first provider group through the %s route",
  async (route) => {
    const cleanup = controlledCleanup({ refused: true });
    const clients = ["claude"];
    const configuration: DoctorProviderConfiguration = {
      environment: {},
      failure: {
        detail: "Selected registration could not be read",
        remediation: "Repair the selected registration",
        code: "selected_registration_unreadable",
        classification: "unknown",
      },
    };
    let selections = 0;
    let groups = 0;
    const host = systemDoctorHost({
      environment: {},
      selectProviderConfiguration: async (owner, _signal, selectedClients) => {
        expect(selectedClients).toBe(clients);
        selections++;
        owner.retain(cleanup, "selected-registration-file");
        return configuration;
      },
      providerInspections: [
        async () => {
          groups++;
          return [];
        },
        async () => {
          groups++;
          return [];
        },
      ],
    });
    try {
      const providerHost =
        route === "direct"
          ? host
          : (await host.forProviderDiagnostics!(clients)).host;
      const failure = await settledCause(
        providerHost.providerInspections!(clients),
      );
      if (!(failure instanceof AnalysisError))
        throw new Error("Expected selected-registration cleanup failure");
      expect(failure.cleanupResources).toEqual(["selected-registration-file"]);
      expect(failure.cleanupIncomplete).toBe(true);
      expect(failure.diagnostics).toMatchObject({
        provider_inspections: [],
        provider_inspection_groups: { completed: 0, total: 2 },
      });
      expect(selections).toBe(1);
      expect(groups).toBe(0);
      expect(cleanup.attempts).toBe(1);
      cleanup.allow();
      await host.close!();
      expect(failure.cleanupIncomplete).toBe(false);
      expect(cleanup.attempts).toBe(2);
    } finally {
      cleanup.allow();
      await host.close!();
    }
  },
);

it("keeps the selected configuration and partial inspections in the same provider cleanup scope", async () => {
  const selectedCleanup = controlledCleanup();
  const providerCleanup = controlledCleanup({ refused: true });
  const completed = providerInspection("ghidra", true);
  const configuration: DoctorProviderConfiguration = {
    environment: { HOPPER_LAUNCHER_PATH: "/selected/hopper" },
    savedDefaults: new Set(["HOPPER_LAUNCHER_PATH"]),
  };
  const clients = ["claude"];
  let selections = 0;
  let laterGroups = 0;
  const host = systemDoctorHost({
    environment: { HOPPER_LAUNCHER_PATH: "/terminal/hopper" },
    selectProviderConfiguration: async (owner) => {
      selections++;
      owner.retain(selectedCleanup, "selected-registration-file");
      return configuration;
    },
    providerInspections: [
      async (owner, _signal, selectedClients, selectedConfiguration) => {
        expect(selectedClients).toBe(clients);
        expect(selectedConfiguration).toBe(configuration);
        expect(selectedCleanup.attempts).toBe(1);
        owner.retain(providerCleanup, "selected-provider-command");
        return [completed];
      },
      async () => {
        laterGroups++;
        return [];
      },
    ],
  });
  try {
    const view = await host.forProviderDiagnostics!(clients);
    expect(view.configuration).toBe(configuration);
    expect(view.host.configuredHopperPath).toBe("/selected/hopper");
    const failure = await settledCause(view.host.providerInspections!(clients));
    if (!(failure instanceof AnalysisError))
      throw new Error("Expected selected-provider cleanup failure");
    expect(failure.cleanupResources).toEqual(["selected-provider-command"]);
    expect(failure.diagnostics).toMatchObject({
      provider_inspections: [completed],
      provider_inspection_groups: { completed: 1, total: 2 },
    });
    expect(selections).toBe(1);
    expect(laterGroups).toBe(0);
    expect([selectedCleanup.attempts, providerCleanup.attempts]).toEqual([
      1, 1,
    ]);
    providerCleanup.allow();
    await host.close!();
    expect(failure.cleanupIncomplete).toBe(false);
    expect([selectedCleanup.attempts, providerCleanup.attempts]).toEqual([
      1, 2,
    ]);
  } finally {
    providerCleanup.allow();
    await host.close!();
  }
});

it.each([false, true])(
  "retains selected-configuration cleanup when no provider view is consumed (selection throws: %s)",
  async (selectionThrows) => {
    const cleanup = controlledCleanup();
    const primary = new ProviderAdapterError("ghidra", "doctor", {
      diagnostics: { reason: "controlled configuration-selection fault" },
    });
    const host = systemDoctorHost({
      environment: {},
      selectProviderConfiguration: async (owner) => {
        owner.retain(cleanup, "selected-registration-file");
        if (selectionThrows) throw primary;
        return { environment: {} };
      },
      providerInspections: async () => [],
    });
    try {
      const selecting = host.forProviderDiagnostics!(["claude"]);
      if (selectionThrows) await expect(selecting).rejects.toBe(primary);
      else await selecting;
      expect(cleanup.attempts).toBe(0);
      await host.close!();
      expect(cleanup.attempts).toBe(1);
    } finally {
      await host.close!();
    }
  },
);

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

it.each([
  ["active group", false],
  ["active group", true],
  ["cleanup gate", false],
  ["cleanup gate", true],
] as const)(
  "retains completed inspections when host closure interrupts the %s (caller cancelled first: %s)",
  async (stage, callerCancelledFirst) => {
    const controller = new AbortController();
    const reason = { request: "cancel before doctor host closes" };
    const completed = providerInspection("ghidra", true);
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let laterGroups = 0;
    let cleanupAttempts = 0;
    const host = systemDoctorHost({
      environment: {},
      signal: controller.signal,
      providerInspections: [
        async (owner) => {
          if (stage === "active group") {
            enter();
            await released;
          } else {
            owner.retain(
              {
                close: async () => {
                  cleanupAttempts++;
                  enter();
                  await released;
                },
              },
              "completed-provider-command",
            );
          }
          return [completed];
        },
        async () => {
          laterGroups++;
          return [providerInspection("kuna", true)];
        },
      ],
    });
    const inspection = runDoctorOwned(
      undefined,
      createDoctorHostFixture({
        signal: controller.signal,
        providerInspections: host.providerInspections!,
        close: host.close!,
      }),
    ).catch((cause: unknown) => cause);
    let closing: Promise<unknown> | undefined;
    await withVerifierCleanup(async () => {
      await awaitAcknowledgement(entered, inspection, "doctor closure gate");
      if (callerCancelledFirst) controller.abort(reason);
      closing = host.close!();
      release();
      const failure = await inspection;
      expect(failure).toBeInstanceOf(AnalysisCancelledError);
      if (!(failure instanceof AnalysisCancelledError))
        throw new Error("Expected typed doctor closure cancellation");
      expect(failure.cause).toBe(
        callerCancelledFirst ? reason : OwnerCancellation.startupOwnerClosed,
      );
      expect(
        JSON.parse(JSON.stringify(projectAnalysisError(failure))),
      ).toMatchObject({
        code: "cancelled",
        details: {
          diagnostics: {
            provider_inspections: [completed],
            provider_inspection_groups: { completed: 1, total: 2 },
          },
        },
      });
      expect(laterGroups).toBe(0);
      expect(cleanupAttempts).toBe(stage === "cleanup gate" ? 1 : 0);
      await closing;
    }, [
      () => release(),
      async () => {
        await inspection;
      },
      async () => {
        await closing;
      },
      () => host.close!(),
    ]);
  },
);

it("preserves an admitted provider's physical failure when its host closes", async () => {
  const primary = new ProviderAdapterError("kuna", "doctor", {
    diagnostics: { reason: "controlled provider fault during closure" },
  });
  const completed = providerInspection("ghidra", true);
  let closing: Promise<unknown> | undefined;
  let laterGroups = 0;
  const host = systemDoctorHost({
    environment: {},
    providerInspections: [
      async () => [completed],
      async () => {
        closing = host.close!();
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
        providerInspections: host.providerInspections!,
        close: host.close!,
      }),
    ),
  ).rejects.toBe(primary);
  expect(primary.diagnostics).toMatchObject({
    reason: "controlled provider fault during closure",
    provider_inspections: [completed],
    provider_inspection_groups: { completed: 1, total: 3 },
  });
  expect(laterGroups).toBe(0);
  await closing;
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
