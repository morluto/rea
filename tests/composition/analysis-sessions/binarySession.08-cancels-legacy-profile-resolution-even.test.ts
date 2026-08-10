import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

import type {
  AnalysisClient,
  AnalysisProvider,
  CapabilityDescriptor,
} from "../../../src/application/AnalysisProvider.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { createAnalysisProfile } from "../../../src/domain/analysisProfile.js";
import { HopperStartError } from "../../../src/domain/errors.js";
import { ProviderCleanupError } from "../../../src/domain/providerCleanupError.js";
import { err, ok as resultOk } from "../../../src/domain/result.js";
import { observed as ok } from "../../fixtures/analysisExecution.js";

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
    resolveAnalysisProfile: () =>
      Promise.resolve(
        resultOk({
          profile: createAnalysisProfile(identity, 1, { fixture: true }),
          compatibility: {},
        }),
      ),
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
  const directory = await createTestTempDirectory("bb-session-");
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

describe("binary session", () => {
  it("cancels legacy profile resolution even when the provider ignores its signal", async () => {
    const [first] = await targets();
    const provider = cacheProvider([]);
    let observedSignal: AbortSignal | undefined;
    let created = 0;
    provider.resolveAnalysisProfile = (_target, options) => {
      observedSignal = options?.signal;
      return new Promise<never>(() => undefined);
    };
    provider.createClient = () => {
      created += 1;
      return new TestClient();
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
    const [first] = await targets();
    const health = deferred<ReturnType<typeof ok>>();
    const session = createTestBinarySession(
      () => new TestClient(health.promise),
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
    const [first, second] = await targets();
    const clients: TestClient[] = [];
    const session = createTestBinarySession(() => {
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
    await session.open(first);
    await session.open(second);
    expect(overlapped).toBe(false);
    await session.close();
  });

  it("clears session state while preserving a typed provider cleanup failure", async () => {
    const [first] = await targets();
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
