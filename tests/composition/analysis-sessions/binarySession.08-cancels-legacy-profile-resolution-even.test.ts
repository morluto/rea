import { describe, expect, it } from "vitest";

import {
  ControllableAnalysisClient,
  createBinarySessionTargets,
  createCacheProvider,
  createDeferred,
  createTestBinarySession,
} from "../../fixtures/binarySession.js";
import { ProviderCleanupError } from "../../../src/domain/providerCleanupError.js";
import { err } from "../../../src/domain/result.js";
import { observed as ok } from "../../fixtures/analysisExecution.js";

describe("binary session", () => {
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
    await session.open(first);
    await session.open(second);
    expect(overlapped).toBe(false);
    await session.close();
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
