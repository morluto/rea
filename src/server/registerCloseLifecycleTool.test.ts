import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { describe, expect, it, vi } from "vitest";

import { toolContract } from "../contracts/toolContracts.js";
import {
  AnalysisTimeoutError,
  AnalysisOutputError,
} from "../domain/analysisErrorCore.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import {
  createTestBinarySession,
  createBinarySessionTargets,
  createDeferred,
  createCacheProvider,
} from "../../tests/fixtures/binarySession.js";
import { observed } from "../../tests/fixtures/analysisExecution.js";
import type { BinarySessionPort } from "../application/binary/BinarySessionPort.js";
import { err, ok } from "../domain/result.js";
import { retainSavedAnalysisSnapshot } from "../domain/savedAnalysisSnapshot.js";
import type { LifecycleToolRegistration } from "./registerSessionTools.js";
import { registerCloseLifecycleTool } from "./registerCloseLifecycleTool.js";

type Handler = (
  input: Record<string, unknown>,
  context: unknown,
) => Promise<unknown>;

const register = (overrides: {
  readonly closeSession?: () => Promise<unknown>;
  readonly session?: BinarySessionPort;
  readonly closeProcessResources?: LifecycleToolRegistration["closeProcessResources"];
  readonly retry: () => Promise<unknown>;
}): {
  readonly handler: (input?: Record<string, unknown>) => Promise<unknown>;
} => {
  let handler: Handler | undefined;
  const registration = {
    server: {
      registerTool: (_name: string, _options: unknown, callback: Handler) => {
        handler = callback;
      },
      delivery: { toCallToolResult: (result: unknown) => result },
    },
    session:
      overrides.session ?? {
        close: overrides.closeSession,
        closeWithSnapshot: overrides.closeSession,
      },
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
    closeContract: toolContract("close_binary"),
    closeProcessResources:
      overrides.closeProcessResources ?? (async () => ok(null)),
    retryReverseEngineeringCleanup: overrides.retry,
  } as unknown as LifecycleToolRegistration;
  registerCloseLifecycleTool(registration);
  return {
    handler: (input = {}) =>
      handler!(input, {
        mcpReq: { _meta: undefined, notify: async () => undefined },
      }),
  };
};

describe("close lifecycle reverse cleanup ordering", () => {
  it("retries reverse cleanup only after the session close has settled", async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { handler } = register({
      closeSession: async () => {
        order.push("close-start");
        await gate;
        order.push("close-end");
        return ok({ closed: true });
      },
      retry: async () => {
        order.push("retry");
        return ok(null);
      },
    });

    const running = handler();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual(["close-start"]);
    release();
    await running;

    expect(order).toEqual(["close-start", "close-end", "retry"]);
  });

  it("keeps reverse cleanup failure primary when the session close also fails", async () => {
    const reverse = new AnalysisOutputError("rizin", "descendant still live", {
      cleanup: { reason: "still live", resources: ["rizin-owner"] },
    });
    const { handler } = register({
      closeSession: async () =>
        err(new AnalysisOutputError("close_binary", "snapshot write failed")),
      retry: async () => err(reverse),
    });

    const result = (await handler()) as {
      ok: boolean;
      error: AnalysisOutputError;
    };

    expect(result.ok).toBe(false);
    expect(result.error.cleanupPrimary).toBe(reverse);
    expect(result.error.cleanupIncomplete).toBe(true);
    expect(result.error.diagnostics).toHaveProperty("cleanup_error");
  });

  it("preserves the saved snapshot receipt on the combined error when both session close and reverse cleanup fail", async () => {
    const reverse = new AnalysisOutputError("rizin", "descendant still live", {
      cleanup: { reason: "still live", resources: ["rizin-owner"] },
    });
    const sessionFailure = new AnalysisOutputError("close_binary", "session cleanup failed", {
      cleanup: { reason: "client still live", resources: ["client-owner"] },
    });
    const receipt = {
      path: "/tmp/saved.json",
      bytes: 100,
      primitive_entries: 1,
      workflow_entries: 0,
      evidence_records: 1,
    };
    retainSavedAnalysisSnapshot(sessionFailure, receipt);
    const { handler } = register({
      closeSession: async () => err(sessionFailure),
      retry: async () => err(reverse),
    });

    const result = (await handler({ snapshot_path: "/tmp/saved.json" })) as {
      ok: boolean;
      error: AnalysisOutputError;
    };

    expect(result.ok).toBe(false);
    expect(result.error.partialObservation).toMatchObject({
      saved_snapshot: receipt,
    });
  });
});

it.each(["cleanup", "timeout"] as const)(
  "confirms close after the actual external %s owner recovers",
  async (kind) => {
    const session = createTestBinarySession(() => ({
      execute: async () => observed(null),
      close: async () => ok(null),
    }));
    const failure =
      kind === "timeout"
        ? new AnalysisTimeoutError("execute_rizin_command", 12, {
            cleanup: { reason: "writer still live", resources: ["writer"] },
          })
        : new ProviderCleanupError("rizin", ["writer"], {
            reason: "writer still live",
          });
    await session.withAdmittedExternalMutation(
      undefined,
      undefined,
      async () => err(failure),
      (_value, error) => error,
    );
    const { handler } = register({
      session,
      retry: async () => {
        failure.resolveCleanup();
        return ok(null);
      },
    });
    expect(await handler()).toEqual(ok(null));
    expect(failure.cleanupIncomplete).toBe(false);
    if (kind === "timeout") expect(failure._tag).toBe("AnalysisTimeoutError");
  },
);

it("preserves an independent analysis-client failure even when reverse cleanup resolves its marker", async () => {
  const [target] = await createBinarySessionTargets();
  const failure = new AnalysisTimeoutError("close_binary", 12, {
    cleanup: { reason: "independent cleanup", resources: ["client"] },
  });
  const close = vi.fn(async () => err(failure));
  const session = createTestBinarySession(() => ({
    execute: async () => observed(null),
    close,
  }));
  expect((await session.open(target)).ok).toBe(true);
  const { handler } = register({
    session,
    retry: async () => {
      failure.resolveCleanup();
      return ok(null);
    },
  });
  expect(await handler()).toEqual(err(failure));
  expect(close).toHaveBeenCalledTimes(1);
  expect(failure._tag).toBe("AnalysisTimeoutError");
});

it("holds a queued open behind the same close transition while the writer owner retries", async () => {
  const [target] = await createBinarySessionTargets();
  const session = createTestBinarySession(() => ({
    execute: async () => observed(null),
    close: async () => ok(null),
  }));
  const failure = new ProviderCleanupError("rizin", ["writer"], {
    reason: "still live",
  });
  await session.withAdmittedExternalMutation(
    undefined,
    undefined,
    async () => err(failure),
    (_value, error) => error,
  );
  const entered = createDeferred<void>();
  const release = createDeferred<void>();
  const { handler } = register({
    session,
    retry: async () => {
      entered.resolve();
      await release.promise;
      failure.resolveCleanup();
      return ok(null);
    },
  });
  const closing = handler();
  await entered.promise;
  const opening = session.open(target);
  expect(session.activeTarget()).toBeUndefined();
  release.resolve();
  expect(await closing).toEqual(ok(null));
  expect((await opening).ok).toBe(true);
  expect(session.activeTarget()?.path).toBe(target);
  await session.close();
});

it("preserves a saved snapshot receipt and performs reverse cleanup once", async () => {
  const directory = await createTestTempDirectory("rea-close-receipt-");
  const path = join(directory, "snapshot.json");
  const [target] = await createBinarySessionTargets();
  const session = createTestBinarySession(createCacheProvider([]));
  expect((await session.open(target)).ok).toBe(true);
  const write = vi.spyOn(session, "writeAnalysisSnapshot");
  const retry = vi.fn(async () => {
    expect((await readFile(path, "utf8")).length).toBeGreaterThan(0);
    return ok(null);
  });
  const { handler } = register({ session, retry });
  expect(
    await handler({ snapshot_path: path, overwrite: false }),
  ).toMatchObject({
    ok: true,
    value: {
      path,
      primitive_entries: 0,
      workflow_entries: 0,
      evidence_records: 0,
    },
  });
  expect(write).toHaveBeenCalledTimes(1);
  expect(retry).toHaveBeenCalledTimes(1);
});

it("still retries reverse cleanup after snapshot refusal without replacing that failure", async () => {
  const directory = await createTestTempDirectory("rea-close-refusal-");
  const path = join(directory, "snapshot.json");
  await writeFile(path, "caller snapshot");
  const [target] = await createBinarySessionTargets();
  const session = createTestBinarySession(createCacheProvider([]));
  expect((await session.open(target)).ok).toBe(true);
  const retry = vi.fn(async () => ok(null));
  const { handler } = register({ session, retry });
  expect(
    await handler({ snapshot_path: path, overwrite: false }),
  ).toMatchObject({ ok: false });
  expect(await readFile(path, "utf8")).toBe("caller snapshot");
  expect(retry).toHaveBeenCalledTimes(1);
});

it.each([
  [true, true, false],
  [true, false, true],
  [false, true, true],
  [true, true, true],
])(
  "retains every independent close owner (session %s, process %s, reverse %s)",
  async (sessionFails, processFails, reverseFails) => {
    const client = new ProviderCleanupError("fixture", ["client"], {});
    const process = new ProviderCleanupError("fixture", ["process"], {});
    const reverse = new ProviderCleanupError("rizin", ["writer"], {});
    const failures = [
      ...(sessionFails ? [client] : []),
      ...(processFails ? [process] : []),
      ...(reverseFails ? [reverse] : []),
    ];
    const { handler } = register({
      closeSession: async () => (sessionFails ? err(client) : ok(null)),
      closeProcessResources: async () =>
        processFails ? err(process) : ok(null),
      retry: async () => (reverseFails ? err(reverse) : ok(null)),
    });
    const result = (await handler()) as {
      ok: false;
      error: AnalysisOutputError;
    };
    expect(result.ok).toBe(false);
    expect(new Set(result.error.cleanupResources)).toEqual(
      new Set(failures.flatMap((failure) => failure.cleanupResources)),
    );
    // The reverse writer settles first; other owners must keep the aggregate live.
    const order = [
      ...(reverseFails ? [reverse] : []),
      ...(sessionFails ? [client] : []),
      ...(processFails ? [process] : []),
    ];
    for (const [index, failure] of order.entries()) {
      failure.resolveCleanup();
      expect(result.error.cleanupIncomplete).toBe(index < order.length - 1);
      expect(new Set(result.error.cleanupResources)).toEqual(
        new Set(
          order.slice(index + 1).flatMap((pending) => pending.cleanupResources),
        ),
      );
    }
  },
);

it("invokes a synchronously throwing reverse owner once and preserves independent client failure", async () => {
  const failure = new Error("reverse cleanup threw");
  const client = new ProviderCleanupError("fixture", ["client"], {});
  const close = vi.fn(async () => err(client));
  const retry = vi.fn((): Promise<never> => {
    throw failure;
  });
  const [target] = await createBinarySessionTargets();
  const session = createTestBinarySession(() => ({
    execute: async () => observed(null),
    close,
  }));
  expect((await session.open(target)).ok).toBe(true);
  const { handler } = register({ session, retry });
  await expect(handler()).rejects.toBe(failure);
  expect(retry).toHaveBeenCalledTimes(1);
  expect(close).toHaveBeenCalledTimes(1);
  expect(client.cleanupIncomplete).toBe(true);
});

it.each(["throw", "reject"] as const)(
  "composes typed reverse cleanup %s with the independent client owner",
  async (mode) => {
    const client = new ProviderCleanupError("fixture", ["client"], {});
    const reverse = new AnalysisOutputError("rizin", "writer cleanup failed", {
      cleanup: { reason: "still live", resources: ["writer"] },
    });
    const [target] = await createBinarySessionTargets();
    const session = createTestBinarySession(() => ({
      execute: async () => observed(null),
      close: async () => err(client),
    }));
    expect((await session.open(target)).ok).toBe(true);
    const retry = vi.fn((): Promise<never> => {
      if (mode === "throw") throw reverse;
      return Promise.reject(reverse);
    });
    const { handler } = register({ session, retry });
    const result = (await handler()) as {
      ok: false;
      error: AnalysisOutputError;
    };
    expect(result.ok).toBe(false);
    expect(result.error.cleanupPrimary).toBe(reverse);
    expect(new Set(result.error.cleanupResources)).toEqual(
      new Set(["client", "writer"]),
    );
    expect(retry).toHaveBeenCalledTimes(1);
    reverse.resolveCleanup();
    expect(result.error.cleanupIncomplete).toBe(true);
    expect(result.error.cleanupResources).toEqual(["client"]);
    client.resolveCleanup();
    expect(result.error.cleanupIncomplete).toBe(false);
  },
);
