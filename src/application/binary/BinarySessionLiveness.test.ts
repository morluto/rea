import {
  availableFixtureProvider,
  supportedFixtureTarget,
} from "../../../tests/fixtures/analysisExecution.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { phaseGate } from "../../../tests/support/lifecycleHarness.js";
import { withVerifierCleanup } from "../../../scripts/lib/verifier-cleanup.mjs";
import { elf } from "../../domain/binaryTarget.fixture.js";
import { describe, expect, it, onTestFinished } from "vitest";

import {
  createAnalysisExecution,
  type AnalysisClient,
  type AnalysisOperation,
  type AnalysisProvider,
  type AnalysisProviderCandidate,
  type CapabilityDescriptor,
  type ProviderIdentity,
} from "../../ports/AnalysisProvider.js";
import { createAnalysisProfile } from "../../domain/analysisProfile.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../../domain/providerCleanupError.js";
import type { ProviderOperationHealth } from "../../domain/providerOperationHealth.js";
import { err, ok } from "../../domain/result.js";
import { buildCapabilityInventory } from "../CapabilityInventory.js";
import { InvestigationRecords } from "../investigation/InvestigationRecords.js";
import { AnalysisProviderRegistry } from "./AnalysisProviderRegistry.js";
import { BinarySession } from "./BinarySession.js";
import { SessionProviderRouter } from "./SessionProviderRouter.js";

it("binds omitted provider subjects to the selected target", async () => {
  const { session } = openSession();
  const opened = await session.open(process.execPath);
  expect(opened.ok).toBe(true);
  const execution = await session.execute("address_name", {});
  expect(execution.ok).toBe(true);
  if (!execution.ok || !opened.ok) return;
  expect(execution.value.subject).toEqual({
    path: opened.value.path,
    sha256: opened.value.sha256,
    format: opened.value.format,
    ...(opened.value.architecture === undefined
      ? {}
      : { architecture: opened.value.architecture }),
  });
});

it("retains live source Evidence without replaying a prior observation", async () => {
  const { session, deep } = openSession({ live: true });
  expect((await session.open(process.execPath)).ok).toBe(true);
  expect(
    (
      await session.execute("address_name", {
        document: "0",
        address: "0x9999",
      })
    ).ok,
  ).toBe(true);
  const child = deep.created[0];
  if (child === undefined) throw new Error("expected provider child");
  let reads = 0;
  child.execute = () =>
    Promise.resolve(
      ok(createAnalysisExecution(`live ${++reads}`, deepIdentity)),
    );
  const parameters = { document: "0", address: "0x1000" };
  const first = await session.execute("address_name", parameters);
  const second = await session.execute("address_name", parameters);
  expect(first.ok && first.value.result).toBe("live 1");
  expect(second.ok && second.value.result).toBe("live 2");
  if (!first.ok || !second.ok) return;
  expect(first.value.evidenceId).toBeDefined();
  expect(second.value.evidenceId).toBeDefined();
  expect(first.value.evidenceId).not.toBe(second.value.evidenceId);
  expect(session.exportEvidenceBundle().records).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ normalized_result: "live 1" }),
      expect.objectContaining({ normalized_result: "live 2" }),
    ]),
  );
  const snapshot = session.exportAnalysisSnapshot();
  expect(snapshot.ok, snapshot.ok ? undefined : snapshot.error.message).toBe(
    true,
  );
  if (!snapshot.ok) return;
  expect(snapshot.value.entries).toEqual([]);
});

it("keeps unbound observations out of persisted target snapshots", async () => {
  const { session, deep } = openSession();
  const directory = await createTestTempDirectory("rea-unbound-snapshot-");
  const path = join(directory, "snapshot.json");
  const parameters = { document: "0", address: "0x1000" };
  expect((await session.open(process.execPath)).ok).toBe(true);
  const bound = await session.execute("address_name", parameters);
  if (!bound.ok) throw bound.error;
  const child = deep.created[0];
  if (child === undefined) throw new Error("Expected bound read");
  const liveReplay = await session.execute("address_name", parameters);
  if (!liveReplay.ok) throw liveReplay.error;
  expect(
    liveReplay.value.sourceEvidence?.map((source) => source.evidence_id),
  ).toEqual([bound.value.evidenceId]);
  child.execute = () =>
    Promise.resolve(
      ok(
        createAnalysisExecution("unbound observation", deepIdentity, {
          subject: null,
        }),
      ),
    );
  const execution = await session.execute("address_name", {
    ...parameters,
    address: "0x2000",
  });
  expect(execution.ok).toBe(true);
  if (!execution.ok) return;
  expect(execution.value.subject).toBeNull();
  expect(session.exportEvidenceBundle().records).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        subject: expect.objectContaining({
          identity: { kind: "unknown", reason: "not-observed" },
        }),
        normalized_result: "unbound observation",
      }),
    ]),
  );
  const snapshot = session.exportAnalysisSnapshot();
  expect(snapshot.ok, snapshot.ok ? undefined : snapshot.error.message).toBe(
    true,
  );
  if (!snapshot.ok) return;
  expect(snapshot.value.entries).toHaveLength(1);
  expect(snapshot.value.entries[0]?.parameters).toEqual(parameters);
  const unboundReplay = await session.execute("address_name", {
    ...parameters,
    address: "0x2000",
  });
  expect(unboundReplay.ok).toBe(true);
  if (unboundReplay.ok) {
    expect(unboundReplay.value.subject).toBeNull();
    expect(unboundReplay.value.evidenceId).toBe(execution.value.evidenceId);
  }
  expect(
    (await session.writeAnalysisSnapshot(snapshot.value, path, false)).ok,
  ).toBe(true);
  expect((await session.close()).ok).toBe(true);
  expect(
    (
      await session.open(process.execPath, {
        loadSnapshot: () => session.readAnalysisSnapshot(path),
      })
    ).ok,
  ).toBe(true);
  const replay = await session.execute("address_name", parameters);
  if (!replay.ok) throw replay.error;
  expect(replay.value.evidenceId).toBe(bound.value.evidenceId);
  expect(
    replay.value.sourceEvidence?.map((source) => source.evidence_id),
  ).toEqual([bound.value.evidenceId]);
  expect(replay.value.limitations).toContainEqual(
    expect.stringMatching(/snapshot.*did not re.run the provider/iu),
  );
});

// Keep the same-target reopen regression from issue #1719 exercised through
// the real router and composite. The child snapshot takes precedence over the
// health probe, and an incomplete startup must retire its retained client.
describe("BinarySession open liveness", () => {
  it("retires a locally blocked owner even when its native health is idle", async () => {
    const { session, deep } = openSession();
    expect((await session.open(process.execPath)).ok).toBe(true);
    expect((await session.execute("address_name", {})).ok).toBe(true);
    const retained = deep.created[0];
    if (retained === undefined) throw new Error("Expected an acquired child");
    retained.reuseReadiness = () => "blocked";
    expect(retained.operationHealthSnapshot?.()?.state).toBe("idle");
    expect((await session.open(process.execPath)).ok).toBe(true);
    expect(retained.closeCalled).toBe(true);
    expect((await session.execute("address_name", {})).ok).toBe(true);
    expect(deep.created).toHaveLength(2);
  });
  it.each([
    { observation: "idle snapshot", state: undefined, operationHealth: true },
    { observation: "exited snapshot", state: "exited", operationHealth: true },
    {
      observation: "unknown snapshot",
      state: "unknown",
      operationHealth: true,
    },
    {
      observation: "incomplete startup",
      state: "not_started",
      operationHealth: true,
    },
    {
      observation: "successful health probe",
      state: undefined,
      operationHealth: false,
    },
    {
      observation: "failed health probe",
      state: "exited",
      operationHealth: false,
    },
  ] as const)(
    "reopens the same target after a retained child's $observation",
    async ({ state, operationHealth }) => {
      const { session, deep } = openSession({ operationHealth });
      expect((await session.open(process.execPath)).ok).toBe(true);
      expect((await session.execute("address_name", {})).ok).toBe(true);
      const [retained] = deep.created;
      if (retained === undefined) throw new Error("Expected an acquired child");
      if (state !== undefined) retained.kill(state);

      expect((await session.open(process.execPath)).ok).toBe(true);
      expect(retained.healthCalls).toBe(operationHealth ? 0 : 1);
      expect(retained.closeCalled).toBe(state !== undefined);
      expect(deep.created).toHaveLength(1);
      expect((await session.execute("address_name", {})).ok).toBe(true);
      expect(deep.created).toHaveLength(state === undefined ? 1 : 2);
    },
  );

  it("does not instantiate a child to answer health before first use", async () => {
    const { session, deep } = openSession({ operationHealth: false });
    expect((await session.open(process.execPath)).ok).toBe(true);
    expect((await session.open(process.execPath)).ok).toBe(true);
    expect(deep.created).toEqual([]);
  });

  it("reports cancellation without touching the session when aborted mid-probe", async () => {
    const { session, deep, onProbe } = openSession();
    expect((await session.open(process.execPath)).ok).toBe(true);
    expect((await session.execute("address_name", {})).ok).toBe(true);

    const controller = new AbortController();
    // Fire the abort while the fast-path liveness probe is in flight: the
    // hook runs synchronously inside the snapshot read, so the abort lands
    // after the probe started but before the fast-path decision completes.
    let fired = false;
    onProbe(() => {
      if (!fired) {
        fired = true;
        controller.abort();
      }
    });

    const cancelled = await session.open(process.execPath, {
      signal: controller.signal,
    });
    expect(cancelled).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisCancelledError" },
    });
    // The dead-or-live question is moot: the session must be untouched.
    expect(deep.created).toHaveLength(1);
    expect(deep.created[0]?.closeCalled).toBe(false);
    const reopened = await session.open(process.execPath);
    expect(reopened.ok).toBe(true);
    expect(deep.created).toHaveLength(1);
  });
});

it("clears retired runtime availability after cancelled-switch restoration", async () => {
  const closing = phaseGate();
  const { session, deep } = openSession({
    failOperationInitially: true,
    releaseBeforeCleanup: closing.release,
    beforeFirstClose: () => closing.hold(),
  });
  expect((await session.open(process.execPath)).ok).toBe(true);
  expect((await session.execute("address_name", {})).ok).toBe(false);
  const availability = async () =>
    buildCapabilityInventory(await session.status(), {
      processCaptureEnabled: false,
    }).find(({ name }) => name === "address_name");
  const initialAvailability = await availability();
  expect(initialAvailability).toMatchObject({
    available: false,
    reason: "provider_unavailable",
  });
  const originalTarget = session.activeTarget();
  const initialRunId = sessionRunId(await session.status());

  const controller = new AbortController();
  const alternate = join(
    await createTestTempDirectory("rea-liveness-switch-"),
    "alternate.elf",
  );
  await writeFile(alternate, elf(2, 1, 62));
  const switching = session.open(alternate, { signal: controller.signal });
  const cancelled = await withVerifierCleanup(async () => {
    await closing.reached(switching, "provider close");
    controller.abort();
    closing.release();
    return await switching;
  }, [
    closing.release,
    async () => {
      await switching;
    },
  ]);
  expect(cancelled).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisCancelledError" },
  });
  expect(session.activeTarget()).toEqual(originalTarget);
  expect(deep.created).toHaveLength(1);
  expect(deep.created[0]?.closeCalled).toBe(true);
  const restoredStatus = await session.status();
  expect(sessionRunId(restoredStatus)).not.toBe(initialRunId);
  expect(await availability()).toMatchObject({
    available: true,
    reason: "available",
    remediation: null,
  });
  // Cancellation remains the caller-visible outcome after cleanup and
  // restoration, while the new restored client is healthy and usable.
  expect((await session.execute("address_name", {})).ok).toBe(true);
  expect(deep.created).toHaveLength(2);
  expect(await availability()).toMatchObject({
    available: true,
    reason: "available",
    remediation: null,
  });
  deep.created[1]?.setOperationFailure(true);
  expect((await session.execute("address_name", {})).ok).toBe(false);
  expect(await availability()).toMatchObject({
    available: false,
    reason: "provider_unavailable",
  });
  deep.created[1]?.setOperationFailure(false);
  expect((await session.execute("address_name", {})).ok).toBe(true);
  expect(await availability()).toMatchObject({
    available: true,
    reason: "available",
    remediation: null,
  });
});

const sessionRunId = (
  status: Awaited<ReturnType<BinarySession["status"]>>,
): string => {
  if (typeof status !== "object" || status === null || Array.isArray(status))
    throw new Error("Expected a binary session status object");
  const analysisRun = status.analysis_run;
  if (
    typeof analysisRun !== "object" ||
    analysisRun === null ||
    Array.isArray(analysisRun) ||
    typeof analysisRun.run_id !== "string"
  )
    throw new Error("Expected an active analysis run");
  return analysisRun.run_id;
};

interface KillableChild extends AnalysisClient {
  kill(state?: "exited" | "unreachable" | "unknown" | "not_started"): void;
  setOperationFailure(value: boolean): void;
  closeCalled: boolean;
  healthCalls: number;
}

const deepIdentity: ProviderIdentity = {
  id: "liveness-deep",
  name: "Liveness deep provider",
  version: "1",
};

const auxIdentity: ProviderIdentity = {
  id: "liveness-aux",
  name: "Liveness auxiliary provider",
  version: "1",
};

const capability = (
  identity: ProviderIdentity,
  operation: Exclude<AnalysisOperation, "health">,
): CapabilityDescriptor => ({
  provider: identity,
  operation,
  available: true,
  reason: null,
  effects: {
    mutatesArtifact: false,
    launchesProcess: false,
    mayShowUi: false,
    mayAccessNetwork: false,
    mayWriteFilesystem: false,
    changesPermissions: false,
    requiresRoot: false,
  },
  limitations: [],
});

const openSession = (
  options: {
    operationHealth?: boolean;
    failOperationInitially?: boolean;
    beforeFirstClose?: () => Promise<void>;
    releaseBeforeCleanup?: () => void;
    live?: boolean;
  } = {},
): {
  session: BinarySession;
  deep: { created: KillableChild[] };
  onProbe: (hook: () => void) => void;
} => {
  const { provider, created, onProbe } = killableDeepProvider(options);
  // A deep provider plus an auxiliary provider uses the production composite
  // route. Its health probe reaches instantiated children only.
  const aux: AnalysisProvider = {
    identity: () => auxIdentity,
    capabilities: () => [],
    createClient: (): AnalysisClient => ({
      execute: (operation) =>
        Promise.resolve(
          ok(createAnalysisExecution(`aux:${operation}`, auxIdentity)),
        ),
      close: () => Promise.resolve(ok(null)),
    }),
  };
  const session = new BinarySession(
    SessionProviderRouter.selectable(new AnalysisProviderRegistry([provider]), [
      aux,
    ]),
    new InvestigationRecords(),
  );
  onTestFinished(async () => {
    options.releaseBeforeCleanup?.();
    const closed = await session.close();
    if (!closed.ok) throw closed.error;
  });
  return { session, deep: { created }, onProbe };
};

const killableDeepProvider = (options: {
  operationHealth?: boolean;
  failOperationInitially?: boolean;
  beforeFirstClose?: () => Promise<void>;
  live?: boolean;
}): {
  provider: AnalysisProviderCandidate;
  created: KillableChild[];
  onProbe: (hook: () => void) => void;
} => {
  const created: KillableChild[] = [];
  let probeHook: (() => void) | undefined;
  const withOperationHealth = options.operationHealth !== false;
  const provider: AnalysisProviderCandidate = {
    identity: () => deepIdentity,
    capabilities: () => [
      {
        ...capability(deepIdentity, "address_name"),
        ...(options.live ? { cachePolicy: "live" as const } : {}),
      },
    ],
    inspectAvailability: availableFixtureProvider,
    inspectTargetSupport: supportedFixtureTarget,
    resolveAnalysisProfile: () =>
      Promise.resolve(
        ok({
          profile: createAnalysisProfile(
            { id: deepIdentity.id, name: deepIdentity.name, version: "1" },
            { fixture: "liveness" },
          ),
        }),
      ),
    createClient: (): KillableChild => {
      const firstClient = created.length === 0;
      let alive = true;
      let failOperation =
        firstClient && options.failOperationInitially === true;
      let closeCalled = false;
      let healthCalls = 0;
      let deadState: "exited" | "unreachable" | "unknown" | "not_started" =
        "exited";
      const client: KillableChild = {
        execute: (operation) => {
          if (operation === "health") healthCalls += 1;
          return alive && !(operation !== "health" && failOperation)
            ? Promise.resolve(
                ok(
                  createAnalysisExecution(
                    operation === "health" ? null : `liveness:${operation}`,
                    deepIdentity,
                  ),
                ),
              )
            : Promise.resolve(
                err(
                  new ProviderAdapterError(deepIdentity.id, operation, {
                    diagnostics: { reason: "process_killed" },
                  }),
                ),
              );
        },
        // Genuine child-liveness signal, like HopperClient.operationHealth:
        // a recorded process exit stays visible after the kill.
        ...(withOperationHealth
          ? {
              operationHealthSnapshot: (): ProviderOperationHealth => {
                probeHook?.();
                return {
                  state: alive ? "idle" : deadState,
                  stage: alive ? null : "connection",
                  retryAction: alive ? null : "restart_provider",
                  exitCode: alive ? null : 1,
                  requests: [],
                };
              },
            }
          : {}),
        close: async () => {
          closeCalled = true;
          if (firstClient && options.beforeFirstClose !== undefined)
            await options.beforeFirstClose();
          return ok(null);
        },
        get closeCalled() {
          return closeCalled;
        },
        get healthCalls() {
          return healthCalls;
        },
        kill: (
          state:
            | "exited"
            | "unreachable"
            | "unknown"
            | "not_started" = "exited",
        ) => {
          alive = false;
          deadState = state;
        },
        setOperationFailure: (value: boolean) => {
          failOperation = value;
        },
      };
      created.push(client);
      return client;
    },
  };
  return {
    provider,
    created,
    onProbe: (hook: () => void) => {
      probeHook = hook;
    },
  };
};

