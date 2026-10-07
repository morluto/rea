import type {
  AnalysisClient,
  AnalysisProvider,
} from "../../../src/application/AnalysisProvider.js";
import type { BinarySession } from "../../../src/application/binary/BinarySession.js";
import type { JsonValue } from "../../../src/domain/jsonValue.js";
import type { RecordUnknownInput } from "../../../src/domain/residualUnknown.js";
import { createAnalysisProfile } from "../../../src/domain/analysisProfile.js";
import { HopperStartError } from "../../../src/domain/hopperErrors.js";
import { ProviderAdapterError } from "../../../src/domain/providerAdapterError.js";
import { ProviderCleanupError } from "../../../src/domain/providerCleanupError.js";
import { err, ok as resultOk } from "../../../src/domain/result.js";
import { createEvidenceBundle } from "../../../src/domain/evidenceBundle.js";
import { observed as ok } from "../../fixtures/analysisExecution.js";
import {
  ControllableAnalysisClient,
  createBinarySessionTargets,
  createCacheProvider,
  createDeferred,
  createTestBinarySession,
} from "../../fixtures/binarySession.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { copyFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { describe, expect, it } from "vitest";

const nonHopperProvider = (operations: string[]): AnalysisProvider => {
  const provider: AnalysisProvider = {
    identity: () => ({ id: "fixture", name: "Fixture", version: "1" }),
    capabilities: () => [
      {
        provider: { id: "fixture", name: "Fixture", version: "1" },
        operation: "address_name",
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
      },
    ],
    createClient: (_target, _profile, context) => {
      if (context === undefined)
        throw new Error("missing analysis run context");
      return {
        execute: (operation) => {
          operations.push(operation);
          return Promise.resolve(ok(operation));
        },
        runtimeLineageSnapshots: () => [
          {
            provider: provider.identity(),
            observation: {
              status: "verified",
              observedAt: "2026-07-22T10:00:00.000Z",
              lineage: {
                runId: context.runId,
                launcherPid: 100,
                launcherParentPid: 1,
                processGroupId: 100,
                descendants: [
                  { pid: 101, parentPid: 100, processGroupId: 100 },
                ],
              },
            },
          },
        ],
        requestActivitySnapshots: () => [
          {
            provider: provider.identity(),
            active: {
              requestId: 7,
              operation: "analyze_function",
              elapsedMs: 31_000,
              callerState: "cancelled",
            },
            queuedRequests: 2,
          },
        ],
        close: () => Promise.resolve(),
      };
    },
  };
  return provider;
};

const client = (fail = false): AnalysisClient => ({
  execute: () => Promise.resolve(fail ? err(new HopperStartError()) : ok(null)),
  close: () => Promise.resolve(),
});

/** Open a target and run one address_name query, asserting both succeed. */
const openAndExecuteAddressName = async (
  session: BinarySession,
  target: string,
  parameters: Readonly<Record<string, JsonValue>>,
): Promise<void> => {
  expect((await session.open(target)).ok).toBe(true);
  expect((await session.execute("address_name", parameters)).ok).toBe(true);
};

/** Shared network-reachability unknown input at one severity. */
const networkReachabilityUnknown = (
  severity: "medium" | "high",
): RecordUnknownInput => ({
  question: "Does this function reach the network?",
  severity,
  domain: "network",
  supporting_evidence_ids: [],
  contradicting_evidence_ids: [],
  required_authority: "shipped-artifact",
  required_confidence: "observed",
  required_environment: null,
  recommended_probes: [
    { operation: "analyze_function", rationale: "Inspect its callers." },
  ],
  relationships: [],
});

/** Record the shared network-reachability unknown, asserting success. */
const recordNetworkReachabilityUnknown = (
  session: BinarySession,
  severity: "medium" | "high",
): void => {
  expect(session.recordUnknown(networkReachabilityUnknown(severity)).ok).toBe(
    true,
  );
};

describe("detached provider and target metadata", () => {
  it("returns detached provider and target metadata", async () => {
    const [first] = await createBinarySessionTargets();
    const session = createTestBinarySession(createCacheProvider([]));
    expect((await session.open(first)).ok).toBe(true);
    expect(session.status()).toMatchObject({
      analysis_run: {
        run_id: expect.any(String),
        process_lineage: { status: "not_observed" },
      },
    });
    expect(session.listUnknowns()).toEqual([]);
    const identity = session.providerIdentity();
    Reflect.set(identity, "id", "forged");
    expect(session.providerIdentity().id).toBe("fixture");

    const active = session.activeTarget();
    expect(active).toBeDefined();
    if (active !== undefined) Reflect.set(active, "path", "/tmp/forged");
    expect(session.activeTarget()?.path).toBe(first);

    await session.close();
  });
});

describe("non-hopper provider dispatch", () => {
  it("runs through a non-Hopper analysis provider", async () => {
    const [first] = await createBinarySessionTargets();
    const operations: string[] = [];
    const provider = nonHopperProvider(operations);
    const session = createTestBinarySession(provider);
    expect((await session.open(first)).ok).toBe(true);
    expect(await session.execute("address_name", {})).toEqual({
      ok: true,
      value: {
        result: "address_name",
        rawResult: "address_name",
        provider: {
          id: "fixture",
          name: "Fixture analysis provider",
          version: "1",
        },
        limitations: [],
        locations: [],
        subject: {
          format: "analysis-database",
          path: first,
          sha256: expect.any(String),
        },
      },
    });
    expect(provider.identity().id).toBe("fixture");
    expect(provider.capabilities()[0]?.operation).toBe("address_name");
    expect(session.status()).toMatchObject({
      provider: { id: "fixture", name: "Fixture", version: "1" },
      providers: [{ id: "fixture", name: "Fixture", version: "1" }],
      capabilities: [
        {
          operation: "address_name",
          available: true,
          reason: null,
          effects: {
            mutates_artifact: false,
            launches_process: false,
          },
        },
      ],
      analysis_run: {
        run_id: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
        ),
        process_lineage: {
          status: "snapshots",
          snapshots: [
            {
              provider: { id: "fixture", name: "Fixture", version: "1" },
              observation: {
                status: "verified",
                observed_at: "2026-07-22T10:00:00.000Z",
                launcher_pid: 100,
                launcher_parent_pid: 1,
                process_group_id: 100,
                descendants: [
                  { pid: 101, parent_pid: 100, process_group_id: 100 },
                ],
              },
            },
          ],
        },
      },
      analysis_activity: {
        status: "busy",
        providers: [
          {
            provider: { id: "fixture", name: "Fixture", version: "1" },
            active: {
              request_id: 7,
              operation: "analyze_function",
              elapsed_ms: 31_000,
              caller_state: "cancelled",
            },
            queued_requests: 2,
          },
        ],
      },
    });
    expect(operations).toEqual(["health", "address_name"]);
    await session.close();
  });
});

describe("fresh run identity", () => {
  it("allocates one fresh run identity per provider client lifetime", async () => {
    const [first, second] = await createBinarySessionTargets();
    const provider = createCacheProvider([]);
    const createClient = provider.createClient.bind(provider);
    const runIds: string[] = [];
    provider.createClient = (target, profile, context) => {
      if (context === undefined)
        throw new Error("missing analysis run context");
      runIds.push(context.runId);
      return createClient(target, profile, context);
    };
    const session = createTestBinarySession(provider);

    expect((await session.open(first)).ok).toBe(true);
    expect((await session.open(first)).ok).toBe(true);
    expect((await session.open(second)).ok).toBe(true);

    expect(runIds).toHaveLength(2);
    expect(new Set(runIds).size).toBe(2);
    await session.close();
  });
});

describe("evidence metadata imports and snapshot cache", () => {
  it("invalidates cached analysis when an import changes evidence path metadata", async () => {
    const [target] = await createBinarySessionTargets();
    const calls: string[] = [];
    const session = createTestBinarySession(createCacheProvider(calls));
    expect((await session.open(target)).ok).toBe(true);
    expect(
      (
        await session.execute("address_name", {
          address: "0x1000",
          document: "first",
        })
      ).ok,
    ).toBe(true);
    expect(session.exportAnalysisSnapshot().ok).toBe(true);

    const evidence = session
      .exportEvidenceBundle()
      .records.find(({ operation }) => operation === "address_name");
    expect(evidence?.subject).not.toBeNull();
    if (evidence?.subject === null || evidence === undefined) {
      await session.close();
      return;
    }
    expect(
      session.importEvidenceBundle(createEvidenceBundle([evidence])),
    ).toEqual({ ok: true, value: 0 });
    expect(session.exportAnalysisSnapshot().ok).toBe(true);
    const callsAfterInitialRead = [...calls];
    expect(
      (
        await session.execute("address_name", {
          address: "0x1000",
          document: "first",
        })
      ).ok,
    ).toBe(true);
    expect(calls).toEqual(callsAfterInitialRead);

    const relocated = {
      ...evidence,
      subject: {
        ...evidence.subject,
        local_path: `${evidence.subject.local_path}.moved`,
        name: `${evidence.subject.name}.moved`,
      },
    };
    expect(
      session.importEvidenceBundle(createEvidenceBundle([relocated])),
    ).toEqual({ ok: true, value: 0 });
    expect(session.exportEvidenceBundle().records).toContainEqual(relocated);
    expect(
      (
        await session.execute("address_name", {
          address: "0x1000",
          document: "first",
        })
      ).ok,
    ).toBe(true);
    expect(calls).toHaveLength(callsAfterInitialRead.length + 1);
    expect(session.exportAnalysisSnapshot()).toMatchObject({
      ok: false,
      error: {
        message: expect.stringContaining(
          "Analysis snapshots are unavailable after analysis metadata mutations",
        ),
      },
    });
    await session.close();
  });
});

describe("replay of exact immutable calls", () => {
  it("replays exact immutable calls from a matching provider-neutral snapshot", async () => {
    const [first, second] = await createBinarySessionTargets();
    const initialCalls: string[] = [];
    const initial = createTestBinarySession(createCacheProvider(initialCalls));
    expect((await initial.open(first)).ok).toBe(true);
    expect(
      (
        await initial.execute("address_name", {
          address: "0x1000",
          document: "first",
        })
      ).ok,
    ).toBe(true);
    const snapshot = initial.exportAnalysisSnapshot();
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) return;
    expect(snapshot.value.entries).toHaveLength(1);
    await initial.close();

    const replayCalls: string[] = [];
    const replay = createTestBinarySession(createCacheProvider(replayCalls));
    expect(replay.importAnalysisSnapshot(snapshot.value)).toEqual({
      ok: true,
      value: 1,
    });
    expect((await replay.open(first)).ok).toBe(true);
    const cached = await replay.execute("address_name", {
      address: "0x1000",
      document: "first",
    });
    expect(cached.ok).toBe(true);
    if (cached.ok)
      expect(cached.value.limitations).toContainEqual(
        expect.stringContaining("local REA analysis snapshot"),
      );
    expect(
      (
        await replay.execute("set_address_name", {
          address: "0x1000",
          name: "renamed",
          document: "first",
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await replay.execute("address_name", {
          address: "0x1000",
          document: "first",
        })
      ).ok,
    ).toBe(true);
    expect(replayCalls).toEqual(["health", "set_address_name", "address_name"]);
    expect(replay.exportAnalysisSnapshot().ok).toBe(false);
    expect((await replay.open(first)).ok).toBe(true);
    expect(replay.exportAnalysisSnapshot()).toMatchObject({
      ok: true,
      value: { entries: [{ operation: "address_name" }] },
    });
    await replay.close();

    const mismatch = createTestBinarySession(createCacheProvider([]));
    expect(mismatch.importAnalysisSnapshot(snapshot.value).ok).toBe(true);
    const opened = await mismatch.open(second);
    expect(opened.ok).toBe(false);
    if (!opened.ok) expect(opened.error._tag).toBe("EvidenceIntegrityError");
    await mismatch.close();

    const profileMismatchCalls: string[] = [];
    const profileMismatchProvider = createCacheProvider(profileMismatchCalls);
    const identity = profileMismatchProvider.identity();
    profileMismatchProvider.resolveAnalysisProfile = () =>
      Promise.resolve(
        resultOk({
          profile: createAnalysisProfile(
            {
              id: identity.id,
              name: identity.name,
              version: identity.version ?? "fixture-unresolved",
            },
            { fixture: "different-profile" },
          ),
          compatibility: {},
        }),
      );
    const profileMismatch = createTestBinarySession(profileMismatchProvider);
    expect(profileMismatch.importAnalysisSnapshot(snapshot.value).ok).toBe(
      true,
    );
    const profileOpened = await profileMismatch.open(first);
    expect(profileOpened.ok).toBe(false);
    if (!profileOpened.ok) {
      expect(profileOpened.error._tag).toBe("EvidenceIntegrityError");
      expect(profileOpened.error.message).toContain("profile_mismatch");
    }
    expect(profileMismatchCalls).toEqual([]);
    await profileMismatch.close();

    const activeProfileMismatch = createTestBinarySession(
      profileMismatchProvider,
    );
    expect((await activeProfileMismatch.open(first)).ok).toBe(true);
    const activeImport = activeProfileMismatch.importAnalysisSnapshot(
      snapshot.value,
    );
    expect(activeImport.ok).toBe(false);
    if (!activeImport.ok)
      expect(activeImport.error.message).toContain("profile_mismatch");
    await activeProfileMismatch.close();
  });
});

describe("snapshot switch rollback", () => {
  it("retains the previous cache when a target switch snapshot conflicts", async () => {
    const [first] = await createBinarySessionTargets();
    const directory = await createTestTempDirectory("rea-session-copy-");
    const second = join(directory, `second${extname(first)}`);
    await copyFile(first, second);
    const calls: string[] = [];
    const session = createTestBinarySession(createCacheProvider(calls));
    await openAndExecuteAddressName(session, first, {
      address: "0x1000",
      document: "first",
    });
    recordNetworkReachabilityUnknown(session, "medium");
    const originalCache = session.exportAnalysisSnapshot();
    expect(originalCache).toMatchObject({
      ok: true,
      value: { entries: [{ operation: "address_name" }] },
    });

    const conflicting = createTestBinarySession(createCacheProvider([]));
    expect((await conflicting.open(second)).ok).toBe(true);
    recordNetworkReachabilityUnknown(conflicting, "high");
    const conflictingSnapshot = conflicting.exportAnalysisSnapshot();
    expect(conflictingSnapshot.ok).toBe(true);
    if (!conflictingSnapshot.ok || !originalCache.ok) return;
    await conflicting.close();

    expect(
      await session.open(second, { snapshot: conflictingSnapshot.value }),
    ).toMatchObject({ ok: false });
    expect(session.activeTarget()?.path).toBe(first);
    expect(
      (
        await session.execute("address_name", {
          address: "0x1000",
          document: "first",
        })
      ).ok,
    ).toBe(true);
    expect(calls).toEqual(["health", "address_name", "health", "health"]);
    await session.close();
  });
});

describe("snapshot cache eligibility", () => {
  it("does not snapshot reads that depend on the provider cursor", async () => {
    const [first] = await createBinarySessionTargets();
    const calls: string[] = [];
    const session = createTestBinarySession(createCacheProvider(calls));
    await openAndExecuteAddressName(session, first, {});
    expect((await session.execute("address_name", {})).ok).toBe(true);
    expect(calls).toEqual(["health", "address_name", "address_name"]);
    expect(session.exportAnalysisSnapshot()).toMatchObject({
      ok: true,
      value: { entries: [] },
    });
    await session.close();
  });
});

describe("provider health and availability", () => {
  it("publishes provider-health availability changes and resets on target switch", async () => {
    const [first, second] = await createBinarySessionTargets();
    const provider = createCacheProvider([]);
    provider.createClient = () => ({
      execute: (operation) =>
        Promise.resolve(
          operation === "health"
            ? ok(null)
            : err(new ProviderAdapterError("fixture", operation)),
        ),
      close: () => Promise.resolve(),
    });
    const session = createTestBinarySession(provider);
    let changes = 0;
    session.onAvailabilityChanged(() => {
      changes += 1;
    });
    expect((await session.open(first)).ok).toBe(true);
    expect((await session.execute("address_name", {})).ok).toBe(false);
    expect(session.status()).toMatchObject({
      capabilities: expect.arrayContaining([
        expect.objectContaining({
          operation: "address_name",
          available: false,
          reason:
            "ProviderAdapterError: Provider fixture adapter failed during address_name",
        }),
      ]),
    });
    expect(changes).toBe(1);
    expect((await session.open(second)).ok).toBe(true);
    expect(session.status()).toMatchObject({
      capabilities: expect.arrayContaining([
        expect.objectContaining({
          operation: "address_name",
          available: true,
          reason: null,
        }),
      ]),
    });
    expect(changes).toBe(2);
  });

  it("isolates availability observers from execution results and session state", async () => {
    const [first] = await createBinarySessionTargets();
    const provider = createCacheProvider([]);
    let providerCalls = 0;
    provider.createClient = () => ({
      execute: (operation) => {
        if (operation === "health") return Promise.resolve(ok(null));
        providerCalls += 1;
        return Promise.resolve(
          providerCalls === 1
            ? err(new ProviderAdapterError("fixture", operation))
            : ok(operation),
        );
      },
      close: () => Promise.resolve(),
    });
    const session = createTestBinarySession(provider);
    expect((await session.open(first)).ok).toBe(true);
    const input = { address: "0x1000", document: "first" };
    expect((await session.execute("address_name", input)).ok).toBe(false);

    session.onAvailabilityChanged(() => {
      throw new Error("external observer failed");
    });
    session.onAvailabilityChanged(() =>
      Promise.reject(new Error("async external observer failed")),
    );
    let delivered = 0;
    session.onAvailabilityChanged(() => {
      delivered += 1;
    });

    await expect(session.execute("address_name", input)).resolves.toMatchObject(
      { ok: true },
    );
    expect(delivered).toBe(1);
    expect(session.status()).toMatchObject({
      capabilities: expect.arrayContaining([
        expect.objectContaining({
          operation: "address_name",
          available: true,
          reason: null,
        }),
      ]),
    });
    expect((await session.execute("address_name", input)).ok).toBe(true);
    expect(providerCalls).toBe(2);
  });

  it("does not replay operations with filesystem side effects", async () => {
    const [first] = await createBinarySessionTargets();
    const calls: string[] = [];
    const session = createTestBinarySession(createCacheProvider(calls, true));
    expect((await session.open(first)).ok).toBe(true);
    const input = { address: "0x1000", document: "first" };
    expect((await session.execute("address_name", input)).ok).toBe(true);
    expect((await session.execute("address_name", input)).ok).toBe(true);
    expect(calls).toEqual(["health", "address_name", "address_name"]);
    await session.close();
  });
});

describe("typed unavailability without dispatching", () => {
  it("returns typed unavailability without dispatching a partial provider", async () => {
    const [first] = await createBinarySessionTargets();
    const operations: string[] = [];
    const provider: AnalysisProvider = {
      identity: () => ({ id: "partial", name: "Partial", version: "1" }),
      capabilities: () => [
        {
          provider: { id: "partial", name: "Partial", version: "1" },
          operation: "address_name",
          available: false,
          reason: "fixture intentionally omits symbol lookup",
          effects: {
            mutatesArtifact: false,
            launchesProcess: false,
            mayShowUi: false,
            mayAccessNetwork: false,
            mayWriteFilesystem: false,
            changesPermissions: false,
            requiresRoot: false,
          },
          limitations: ["No symbol lookup implementation."],
        },
      ],
      createClient: () => ({
        execute: (operation) => {
          operations.push(operation);
          return Promise.resolve(ok(operation));
        },
        close: () => Promise.resolve(),
      }),
    };
    const session = createTestBinarySession(provider);
    expect((await session.open(first)).ok).toBe(true);
    const result = await session.execute("address_name", {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject({
        _tag: "AnalysisCapabilityUnavailableError",
        providerId: "partial",
        operation: "address_name",
        reason: "fixture intentionally omits symbol lookup",
      });
    }
    expect(operations).toEqual(["health"]);
    await session.close();
  });

  it("requires an open binary and closes idempotently", async () => {
    const session = createTestBinarySession(() => client());
    expect((await session.execute("binary_overview", {})).ok).toBe(false);
    expect(await session.close()).toEqual({ ok: true, value: null });
    expect(await session.close()).toEqual({ ok: true, value: null });
  });

  it("keeps the active client when a switch fails", async () => {
    const [first, second] = await createBinarySessionTargets();
    let created = 0;
    const session = createTestBinarySession(() => client(created++ === 1));
    expect((await session.open(first)).ok).toBe(true);
    expect((await session.open(second)).ok).toBe(false);
    expect(session.status()).toMatchObject({
      open: true,
      sha256:
        "7692c3ad3540bb803c020b3aee66cd8887123234ea0c6e7143c0add73ff431ed",
      architecture: null,
    });
    expect(JSON.stringify(session.status())).toContain("first.hop");
    expect(created).toBe(3);
  });

  it("serializes concurrent opens and leaves the last target active", async () => {
    const [first, second] = await createBinarySessionTargets();
    const clients: ControllableAnalysisClient[] = [];
    const session = createTestBinarySession(() => {
      const value = new ControllableAnalysisClient();
      clients.push(value);
      return value;
    });
    const one = session.open(first);
    const two = session.open(second);
    expect((await one).ok).toBe(true);
    expect((await two).ok).toBe(true);
    expect(session.status()).toMatchObject({ open: true });
    expect(JSON.stringify(session.status())).toContain("second.hop");
    expect(clients[0]?.closed).toBe(1);
  });
});

describe("active client replacement", () => {
  it("replaces the active client when a canonical path changes contents", async () => {
    const directory = await createTestTempDirectory("bb-session-");
    const path = join(directory, "mutable.hop");
    await writeFile(path, "one");
    const clients: Array<{
      readonly targetSha256: string;
      readonly calls: string[];
      closed: number;
    }> = [];
    const session = createTestBinarySession((target) => {
      const state = {
        targetSha256: target.sha256,
        calls: [] as string[],
        closed: 0,
      };
      clients.push(state);
      return {
        execute: (operation) => {
          state.calls.push(operation);
          return Promise.resolve(
            ok(operation === "health" ? null : target.sha256),
          );
        },
        close: () => {
          state.closed += 1;
          return Promise.resolve();
        },
      };
    });

    const first = await session.open(path);
    expect(first.ok).toBe(true);
    await writeFile(path, "two");
    const second = await session.open(path);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    expect(second.value.sha256).not.toBe(first.value.sha256);
    expect(session.activeTarget()?.sha256).toBe(second.value.sha256);
    expect(await session.execute("binary_overview", {})).toMatchObject({
      ok: true,
      value: { result: second.value.sha256 },
    });
    expect(clients).toMatchObject([
      {
        targetSha256: first.value.sha256,
        calls: ["health"],
        closed: 1,
      },
      {
        targetSha256: second.value.sha256,
        calls: ["health", "binary_overview"],
        closed: 0,
      },
    ]);
    await session.close();
  });

  it("waits for an active call before closing its client during a switch", async () => {
    const [first, second] = await createBinarySessionTargets();
    const active = createDeferred<ReturnType<typeof ok>>();
    const clients: ControllableAnalysisClient[] = [];
    const session = createTestBinarySession(() => {
      const value = new ControllableAnalysisClient(
        undefined,
        false,
        clients.length === 0 ? active.promise : undefined,
      );
      clients.push(value);
      return value;
    });
    expect((await session.open(first)).ok).toBe(true);
    const call = session.execute("procedure_pseudo_code", {});
    const switching = session.open(second);
    await Promise.resolve();
    expect(clients[0]?.closed).toBe(0);
    active.resolve(ok(null));
    expect((await call).ok).toBe(true);
    expect((await switching).ok).toBe(true);
    expect(clients[0]?.closed).toBe(1);
  });

  it("cancels an open queued behind another transition without creating a client", async () => {
    const [first, second] = await createBinarySessionTargets();
    const health = createDeferred<ReturnType<typeof ok>>();
    let created = 0;
    const session = createTestBinarySession(() => {
      created += 1;
      return new ControllableAnalysisClient(
        created === 1 ? health.promise : undefined,
      );
    });
    const opening = session.open(first);
    const controller = new AbortController();
    const queued = session.open(second, { signal: controller.signal });
    controller.abort();
    health.resolve(ok(null));
    await opening;
    const result = await queued;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error._tag).toBe("AnalysisCancelledError");
    expect(created).toBe(1);
  });
});

describe("cancellation during profile resolution", () => {
  it("owns provider rejection when profile resolution synchronously cancels opening", async () => {
    const [first] = await createBinarySessionTargets();
    const provider = createCacheProvider([]);
    const controller = new AbortController();
    provider.resolveAnalysisProfile = () => {
      controller.abort();
      return Promise.reject(new Error("Profile resolution cancelled"));
    };
    const session = createTestBinarySession(provider);
    try {
      await expect(
        session.open(first, { signal: controller.signal }),
      ).resolves.toMatchObject({
        ok: false,
        error: { _tag: "AnalysisCancelledError", operation: "open_binary" },
      });
      // Allow Node to report any rejection abandoned by the cancellation path.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(session.activeTarget()).toBeUndefined();
    } finally {
      await session.close();
    }
  });

  it("cancels legacy profile resolution even when the provider ignores its signal", async () => {
    const [first] = await createBinarySessionTargets();
    const provider = createCacheProvider([]);
    let observedSignal: AbortSignal | undefined;
    let created = 0;
    provider.resolveAnalysisProfile = (_target, options) => {
      observedSignal = options?.signal;
      return new Promise<never>(() => undefined);
    };
    provider.createClient = () => {
      created += 1;
      return new ControllableAnalysisClient();
    };
    const session = createTestBinarySession(provider);
    const controller = new AbortController();
    const opening = session.open(first, { signal: controller.signal });
    while (observedSignal === undefined)
      await new Promise<void>((resolve) => setImmediate(resolve));
    expect(observedSignal).toBe(controller.signal);

    controller.abort();

    await expect(opening).resolves.toMatchObject({
      ok: false,
      error: { _tag: "AnalysisCancelledError", operation: "open_binary" },
    });
    expect(created).toBe(0);
  });

  it("cancels a call while it waits for a transition", async () => {
    const [first] = await createBinarySessionTargets();
    const health = createDeferred<ReturnType<typeof ok>>();
    const session = createTestBinarySession(
      () => new ControllableAnalysisClient(health.promise),
    );
    const opening = session.open(first);
    const controller = new AbortController();
    const call = session.execute(
      "binary_overview",
      {},
      {
        signal: controller.signal,
      },
    );
    controller.abort();
    const result = await call;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error._tag).toBe("AnalysisCancelledError");
    health.resolve(ok(null));
    await opening;
  });

  it("closes a failed candidate and reopens the previous target", async () => {
    const [first, second] = await createBinarySessionTargets();
    const clients: ControllableAnalysisClient[] = [];
    const session = createTestBinarySession(() => {
      const value = new ControllableAnalysisClient(
        undefined,
        clients.length === 1,
      );
      clients.push(value);
      return value;
    });
    expect((await session.open(first)).ok).toBe(true);
    expect((await session.open(second)).ok).toBe(false);
    expect((await session.execute("address_name", {})).ok).toBe(true);
    expect(clients[1]?.closed).toBe(1);
    expect(clients[0]?.closed).toBe(1);
    expect(clients[2]?.closed).toBe(0);
    expect(JSON.stringify(session.status())).toContain("first.hop");
    await session.close();
    await session.close();
    expect(clients[2]?.closed).toBe(1);
  });

  it("closes the active bridge before starting a replacement", async () => {
    const [first, second] = await createBinarySessionTargets();
    let liveClients = 0;
    let overlapped = false;
    const session = createTestBinarySession(() => ({
      execute: () => {
        if (liveClients > 0) overlapped = true;
        liveClients += 1;
        return Promise.resolve(ok(null));
      },
      close: () => {
        liveClients -= 1;
        return Promise.resolve();
      },
    }));
    expect((await session.open(first)).ok).toBe(true);
    expect((await session.open(second)).ok).toBe(true);
    expect(liveClients).toBe(1);
    expect(overlapped).toBe(false);
    await session.close();
    expect(liveClients).toBe(0);
  });

  it("clears session state while preserving a typed provider cleanup failure", async () => {
    const [first] = await createBinarySessionTargets();
    const cleanupError = new ProviderCleanupError(
      "fixture",
      ["fixture-document"],
      { reason: "shutdown acknowledgement missing" },
    );
    const session = createTestBinarySession(() => ({
      execute: () => Promise.resolve(ok(null)),
      closeWithOutcome: () => Promise.resolve(err(cleanupError)),
      close: () => Promise.resolve(),
    }));
    expect((await session.open(first)).ok).toBe(true);

    expect(await session.close()).toEqual(err(cleanupError));
    expect(session.status()).toMatchObject({
      open: false,
      analysis_activity: { status: "not_observed", providers: [] },
    });
  });
});

describe("no replacement start", () => {
  it("does not start a replacement after the active provider cleanup is unconfirmed", async () => {
    const [first, second] = await createBinarySessionTargets();
    const cleanupError = new ProviderCleanupError(
      "fixture",
      ["fixture-document"],
      { reason: "shutdown acknowledgement missing" },
    );
    let created = 0;
    const session = createTestBinarySession(() => {
      created += 1;
      return {
        execute: () => Promise.resolve(ok(null)),
        closeWithOutcome: () => Promise.resolve(err(cleanupError)),
        close: () => Promise.resolve(),
      };
    });
    expect((await session.open(first)).ok).toBe(true);

    expect(await session.open(second)).toEqual(err(cleanupError));
    expect(created).toBe(1);
    expect(session.status()).toMatchObject({ open: false });
  });
});
