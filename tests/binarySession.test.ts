import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { BinarySession } from "../src/application/BinarySession.js";
import type { AnalysisClient } from "../src/application/AnalysisProvider.js";
import type {
  AnalysisProvider,
  CapabilityDescriptor,
} from "../src/application/AnalysisProvider.js";
import { HopperStartError } from "../src/domain/errors.js";
import { err } from "../src/domain/result.js";
import { observed as ok } from "./fixtures/analysisExecution.js";

let directory: string | undefined;
afterEach(async () => {
  if (directory !== undefined)
    await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("binary session", () => {
  it("runs through a non-Hopper analysis provider", async () => {
    const [first] = await targets();
    const operations: string[] = [];
    const provider: AnalysisProvider = {
      identity: () => ({ id: "fixture", name: "Fixture", version: "1" }),
      capabilities: () => [
        {
          provider: { id: "fixture", name: "Fixture", version: "1" },
          operation: "address_name",
          inputContractVersion: 1,
          outputContractVersion: 1,
          available: true,
          reason: null,
          pagination: "none",
          exhaustive: true,
          effects: {
            mutatesArtifact: false,
            launchesProcess: false,
            mayShowUi: false,
            mayAccessNetwork: false,
            mayWriteFilesystem: false,
            changesPermissions: false,
            requiresRoot: false,
          },
          limits: {
            maxResults: null,
            maxPayloadBytes: null,
            timeoutMs: null,
          },
          limitations: [],
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
    const session = new BinarySession(provider);
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
        subject: null,
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
    });
    expect(operations).toEqual(["health", "address_name"]);
    await session.close();
  });

  it("replays exact immutable calls from a matching provider-neutral snapshot", async () => {
    const [first, second] = await targets();
    const initialCalls: string[] = [];
    const initial = new BinarySession(cacheProvider(initialCalls));
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
    const replay = new BinarySession(cacheProvider(replayCalls));
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
    await replay.close();

    const mismatch = new BinarySession(cacheProvider([]));
    expect(mismatch.importAnalysisSnapshot(snapshot.value).ok).toBe(true);
    const opened = await mismatch.open(second);
    expect(opened.ok).toBe(false);
    if (!opened.ok) expect(opened.error._tag).toBe("EvidenceIntegrityError");
    await mismatch.close();
  });

  it("does not snapshot reads that depend on the provider cursor", async () => {
    const [first] = await targets();
    const calls: string[] = [];
    const session = new BinarySession(cacheProvider(calls));
    expect((await session.open(first)).ok).toBe(true);
    expect((await session.execute("address_name", {})).ok).toBe(true);
    expect((await session.execute("address_name", {})).ok).toBe(true);
    expect(calls).toEqual(["health", "address_name", "address_name"]);
    expect(session.exportAnalysisSnapshot()).toMatchObject({
      ok: true,
      value: { entries: [] },
    });
    await session.close();
  });

  it("does not replay operations with filesystem side effects", async () => {
    const [first] = await targets();
    const calls: string[] = [];
    const session = new BinarySession(cacheProvider(calls, true));
    expect((await session.open(first)).ok).toBe(true);
    const input = { address: "0x1000", document: "first" };
    expect((await session.execute("address_name", input)).ok).toBe(true);
    expect((await session.execute("address_name", input)).ok).toBe(true);
    expect(calls).toEqual(["health", "address_name", "address_name"]);
    await session.close();
  });

  it("returns typed unavailability without dispatching a partial provider", async () => {
    const [first] = await targets();
    const operations: string[] = [];
    const provider: AnalysisProvider = {
      identity: () => ({ id: "partial", name: "Partial", version: "1" }),
      capabilities: () => [
        {
          provider: { id: "partial", name: "Partial", version: "1" },
          operation: "address_name",
          inputContractVersion: 1,
          outputContractVersion: 1,
          available: false,
          reason: "fixture intentionally omits symbol lookup",
          pagination: "none",
          exhaustive: false,
          effects: {
            mutatesArtifact: false,
            launchesProcess: false,
            mayShowUi: false,
            mayAccessNetwork: false,
            mayWriteFilesystem: false,
            changesPermissions: false,
            requiresRoot: false,
          },
          limits: {
            maxResults: null,
            maxPayloadBytes: null,
            timeoutMs: null,
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
    const session = new BinarySession(provider);
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
    const session = new BinarySession(() => client());
    expect((await session.execute("binary_overview", {})).ok).toBe(false);
    expect(await session.close()).toEqual({ ok: true, value: null });
  });

  it("keeps the active client when a switch fails", async () => {
    directory = await mkdtemp(join(tmpdir(), "bb-session-"));
    const first = join(directory, "first.hop");
    const second = join(directory, "second.hop");
    await writeFile(first, "one");
    await writeFile(second, "two");
    let created = 0;
    const session = new BinarySession(() => client(created++ === 1));
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
    const [first, second] = await targets();
    const clients: TestClient[] = [];
    const session = new BinarySession(() => {
      const value = new TestClient();
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

  it("waits for an active call before closing its client during a switch", async () => {
    const [first, second] = await targets();
    const active = deferred<ReturnType<typeof ok>>();
    const clients: TestClient[] = [];
    const session = new BinarySession(() => {
      const value = new TestClient(
        undefined,
        false,
        clients.length === 0 ? active.promise : undefined,
      );
      clients.push(value);
      return value;
    });
    await session.open(first);
    const call = session.execute("procedure_pseudo_code", {});
    const switching = session.open(second);
    await Promise.resolve();
    expect(clients[0]?.closed).toBe(0);
    active.resolve(ok(null));
    await call;
    await switching;
    expect(clients[0]?.closed).toBe(1);
  });

  it("cancels an open queued behind another transition without creating a client", async () => {
    const [first, second] = await targets();
    const health = deferred<ReturnType<typeof ok>>();
    let created = 0;
    const session = new BinarySession(() => {
      created += 1;
      return new TestClient(created === 1 ? health.promise : undefined);
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

  it("cancels a call while it waits for a transition", async () => {
    const [first] = await targets();
    const health = deferred<ReturnType<typeof ok>>();
    const session = new BinarySession(() => new TestClient(health.promise));
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
    const [first, second] = await targets();
    const clients: TestClient[] = [];
    const session = new BinarySession(() => {
      const value = new TestClient(undefined, clients.length === 1);
      clients.push(value);
      return value;
    });
    await session.open(first);
    await session.open(second);
    expect(clients[1]?.closed).toBe(1);
    expect(clients[0]?.closed).toBe(1);
    expect(clients[2]?.closed).toBe(0);
    expect(JSON.stringify(session.status())).toContain("first.hop");
    await session.close();
    await session.close();
    expect(clients[2]?.closed).toBe(1);
  });

  it("closes the active bridge before starting a replacement", async () => {
    const [first, second] = await targets();
    let liveClients = 0;
    let overlapped = false;
    const session = new BinarySession(() => ({
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
    await session.open(first);
    await session.open(second);
    expect(overlapped).toBe(false);
    await session.close();
  });
});

const client = (fail = false): AnalysisClient => ({
  execute: () => Promise.resolve(fail ? err(new HopperStartError()) : ok(null)),
  close: () => Promise.resolve(),
});

const cacheProvider = (
  calls: string[],
  mayWriteFilesystem = false,
): AnalysisProvider => {
  const identity = {
    id: "fixture",
    name: "Fixture analysis provider",
    version: "1",
  } as const;
  return {
    identity: () => identity,
    capabilities: () => [
      cacheCapability(identity, "address_name", false, mayWriteFilesystem),
      cacheCapability(identity, "set_address_name", true),
    ],
    createClient: () => ({
      execute: (operation) => {
        calls.push(operation);
        return Promise.resolve(ok(operation));
      },
      close: () => Promise.resolve(),
    }),
  };
};

const cacheCapability = (
  provider: CapabilityDescriptor["provider"],
  operation: "address_name" | "set_address_name",
  mutatesArtifact: boolean,
  mayWriteFilesystem = false,
): CapabilityDescriptor => ({
  provider,
  operation,
  inputContractVersion: 1,
  outputContractVersion: 1,
  available: true,
  reason: null,
  pagination: "none",
  exhaustive: true,
  effects: {
    mutatesArtifact,
    launchesProcess: false,
    mayShowUi: false,
    mayAccessNetwork: false,
    mayWriteFilesystem,
    changesPermissions: false,
    requiresRoot: false,
  },
  limits: {
    maxResults: null,
    maxPayloadBytes: null,
    timeoutMs: null,
  },
  limitations: [],
});

class TestClient implements AnalysisClient {
  closed = 0;
  constructor(
    readonly pendingHealth?: Promise<ReturnType<typeof ok>>,
    readonly failHealth = false,
    readonly pendingCall?: Promise<ReturnType<typeof ok>>,
  ) {}
  execute(name: string) {
    if (name === "health")
      return this.failHealth
        ? Promise.resolve(err(new HopperStartError()))
        : (this.pendingHealth ?? Promise.resolve(ok(null)));
    return this.pendingCall ?? Promise.resolve(ok(null));
  }
  close(): Promise<void> {
    this.closed += 1;
    return Promise.resolve();
  }
}

const targets = async (): Promise<readonly [string, string]> => {
  directory ??= await mkdtemp(join(tmpdir(), "bb-session-"));
  const first = join(directory, "first.hop");
  const second = join(directory, "second.hop");
  await writeFile(first, "one");
  await writeFile(second, "two");
  return [first, second];
};

const deferred = <T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} => {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value) {
      resolvePromise?.(value);
    },
  };
};
