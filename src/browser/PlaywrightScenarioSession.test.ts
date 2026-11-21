import { awaitAcknowledgement } from "../../tests/fixtures/lifecycleAcknowledgement.js";
import { phaseGate } from "../../tests/support/lifecycleHarness.js";
import {
  AnalysisCleanupLeaseGroup,
  AnalysisCleanupLease,
} from "../resources/AnalysisCleanupLease.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { PlaywrightBrowserScenarioProvider } from "./PlaywrightBrowserScenarioProvider.js";
import { EventEmitter } from "node:events";

import { beforeEach, expect, it, vi, type Mock } from "vitest";
import type { PlaywrightScenarioStorage } from "./PlaywrightScenarioStorage.js";

const mocks = vi.hoisted(() => ({
  openBrowser: vi.fn(),
  storage: undefined as
    | {
        initialize: Mock<PlaywrightScenarioStorage["initialize"]>;
        settle: Mock<PlaywrightScenarioStorage["settle"]>;
        limitations: Mock<PlaywrightScenarioStorage["limitations"]>;
        close: Mock<PlaywrightScenarioStorage["close"]>;
      }
    | undefined,
  finishEvents: vi.fn(),
  policySend: vi.fn(),
  policyTransportClose: vi.fn(),
  policyBeginCleanupGrace: vi.fn(),
  policyEvent: undefined as
    | ((event: { method: string; params: unknown; sessionId?: string }) => void)
    | undefined,
}));

vi.mock("./CdpTargetSession.js", () => ({
  openCdpEndpoint: async (
    _endpoint: unknown,
    operation: Parameters<
      import("./CdpTargetSessionOwner.js").CdpTargetSessionOwner["register"]
    >[1],
    _signal: unknown,
    _limits: unknown,
    owner: import("./CdpTargetSessionOwner.js").CdpTargetSessionOwner,
  ) => {
    // Admit fake events as CdpConnection does: subscribers read `registered`.
    const { fakeCdpEvents } =
      await import("../../tests/fixtures/fakeCdpEvents.js");
    const events = fakeCdpEvents();
    mocks.policyEvent = events.emit;
    const connection = {
      send: mocks.policySend,
      onEvent: events.onEvent,
      onProtocolFailure: () => () => undefined,
      onDisconnect: () => () => undefined,
      close: mocks.policyTransportClose,
      beginCleanupGrace: mocks.policyBeginCleanupGrace,
    } as unknown as import("./CdpConnection.js").CdpConnection;
    owner.register(connection, operation, "target");
    return {
      discovery: { targets: [{ id: "target" }] },
      connection,
    };
  },
  attachCdpTargetSession: async (connection: unknown) => ({
    connection,
    sessionId: "policy-session",
  }),
}));

vi.mock("./PlaywrightScenarioBrowser.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./PlaywrightScenarioBrowser.js")>()),
  openPlaywrightScenarioBrowser: mocks.openBrowser,
  failBrowserScenarioOperation: async (
    cleanup: { release(): Promise<void> },
    cause: unknown,
  ) => {
    try {
      await cleanup.release();
    } catch (cleanupCause: unknown) {
      throw new AggregateError([cause, cleanupCause]);
    }
    throw cause;
  },
}));

vi.mock("./PlaywrightScenarioStorage.js", () => ({
  PlaywrightScenarioStorage: {
    create: vi.fn(async () => mocks.storage),
  },
}));

vi.mock("./PlaywrightScenarioEvents.js", () => ({
  PlaywrightScenarioEvents: class {
    finish() {
      return mocks.finishEvents();
    }

    result() {
      return {
        retained: 0,
        dropped: 0,
        items: [],
        omissions: {
          by_kind: [],
          network_transactions: [],
          network_transaction_range: null,
        },
      };
    }

    limitations() {
      return [];
    }

    setStep() {}

    nextSequence() {
      return 1;
    }

    lastSequence() {
      return 0;
    }
  },
}));

import { CDP_CLEANUP_GRACE_MS } from "../domain/browserDeadline.js";
import { browserScenarioSchema } from "../domain/browserScenario.js";
import { PlaywrightScenarioSession } from "./PlaywrightScenarioSession.js";
import { CdpCommandRejection } from "./CdpCommandRejection.js";
import { PlaywrightScenarioBrowserCleanupOwner } from "./PlaywrightScenarioBrowser.js";

const scenario = browserScenarioSchema.parse({
  browser: { mode: "launch", executable_path: process.execPath },
  start_url: { url: "https://storage.example.test/" },
  actions: [{ step_id: "wait", action: "wait_for_timeout", duration_ms: 1 }],
  storage: {
    local_storage: [
      {
        origin: "https://storage.example.test",
        entries: [{ name: "seed", value: { source: "literal", value: "v" } }],
      },
    ],
  },
});

const deferred = () => {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
};

const connectedScenario = (
  serviceWorkers: "block" | "allow",
  storage: unknown = scenario.storage,
) =>
  browserScenarioSchema.parse({
    ...scenario,
    browser: {
      mode: "connect",
      cdp_endpoint: "http://127.0.0.1:9222",
      target_id: "target",
    },
    environment: { service_workers: serviceWorkers },
    storage,
  });

const fixture = () => {
  const page = Object.assign(new EventEmitter(), {
    url: () => "about:blank",
    goto: vi.fn(async () => undefined),
    evaluate: vi.fn(async (_script: unknown): Promise<unknown> => null),
    addInitScript: vi.fn(async (_script: unknown) => undefined),
    context: () => context,
    frames: () => [page],
    mainFrame: () => page,
    isDetached: () => false,
    isClosed: (): boolean => false,
    waitForLoadState: vi.fn(async () => undefined),
  });
  const context = Object.assign(new EventEmitter(), {
    setDefaultTimeout: vi.fn(),
    setDefaultNavigationTimeout: vi.fn(),
    addCookies: vi.fn(async () => undefined),
    browser: () => browser,
  });
  const browser = Object.assign(new EventEmitter(), {
    version: () => "Chrome 154",
  });
  let browserClosed = false;
  const close = vi.fn(
    async (
      finishEvents?: () => Promise<void>,
      releaseGate?: { readonly revision: number; run(): Promise<void> },
    ) => {
      await finishEvents?.();
      if (releaseGate !== undefined) {
        for (;;) {
          const revision = releaseGate.revision;
          await releaseGate.run();
          if (releaseGate.revision === revision) break;
        }
      }
      browserClosed = true;
    },
  );
  const cleanup = {
    close,
    release: close,
    cleanupLease: new AnalysisCleanupLease(
      async () => {
        await close();
      },
      {
        get cleanupResources() {
          return browserClosed ? [] : ["browser_transport"];
        },
      },
    ),
    get cleanupResources() {
      return browserClosed ? [] : ["browser_transport"];
    },
    get browserClosed() {
      return browserClosed;
    },
  };
  const opened = {
    page,
    context,
    browser,
    cleanup,
    profilePath: "/tmp/profile",
  };
  mocks.openBrowser.mockResolvedValue(opened);
  mocks.storage = {
    initialize: vi.fn<PlaywrightScenarioStorage["initialize"]>(
      async () => undefined,
    ),
    settle: vi.fn<PlaywrightScenarioStorage["settle"]>(async () => undefined),
    limitations: vi.fn<PlaywrightScenarioStorage["limitations"]>(() => []),
    close: vi.fn<PlaywrightScenarioStorage["close"]>(
      async (stopLoading = false) => ({
        loadingStopped: stopLoading,
      }),
    ),
  };
  return { cleanup, page, context, storage: mocks.storage, opened };
};

const policyResponse = (method: string): unknown =>
  method === "Page.addScriptToEvaluateOnNewDocument"
    ? { identifier: "owned-policy-script" }
    : method === "Runtime.evaluate"
      ? { result: { value: null } }
      : {};

const prepareAttachedCleanup = async (
  serviceWorkers: "block" | "allow",
  cancelAtRelease = false,
) => {
  const { opened, page, storage } = fixture();
  const cancellation = new AbortController();
  const transitions: string[] = [];
  const cleanup = new PlaywrightScenarioBrowserCleanupOwner({
    closeBrowser: async (disconnectAtBoundary) => {
      const closing = disconnectAtBoundary(async () => {
        transitions.push("disconnect");
      });
      // The first gate check has started, but the transport is still open.
      if (cancelAtRelease) cancellation.abort();
      await closing;
    },
    removeProfile: undefined,
  });
  mocks.openBrowser.mockResolvedValue({ ...opened, cleanup });
  storage.close.mockResolvedValue({ loadingStopped: false });
  const session = await PlaywrightScenarioSession.open(
    connectedScenario(serviceWorkers),
    {},
    { signal: cancellation.signal },
  );
  page.evaluate.mockImplementation(async (script: unknown) => {
    if (script === "globalThis.stop()") transitions.push("stop");
    return null;
  });
  return { page, storage, cancellation, session, transitions };
};

const prepareHeldPolicyRestoration = async () => {
  const context = await prepareAttachedCleanup("block");
  const restoration = phaseGate();
  const { promise: transportClosed, resolve: signalTransportClosed } =
    deferred();
  mocks.policyTransportClose.mockImplementation(async () => {
    signalTransportClosed();
  });
  mocks.policySend.mockImplementation(async (method: string) => {
    if (method === "Runtime.evaluate") await restoration.hold();
    if (method === "Page.stopLoading") context.transitions.push("stop");
    return policyResponse(method);
  });
  return { ...context, restoration, transportClosed };
};

const prepareLateStopRetry = async () => {
  const {
    page,
    cancellation,
    session,
    restoration,
    transportClosed,
    transitions,
  } = await prepareHeldPolicyRestoration();
  vi.useFakeTimers();
  try {
    const firstClose = session.close(false).catch((cause: unknown) => cause);
    await restoration.reached(firstClose, "policy restoration");
    await vi.advanceTimersByTimeAsync(CDP_CLEANUP_GRACE_MS);
    expect(await firstClose).toMatchObject({ cleanupIncomplete: true });
    restoration.release();
    await transportClosed;
    await vi.advanceTimersByTimeAsync(0);
    cancellation.abort();
    return { page, session, transitions };
  } catch (cause) {
    restoration.release();
    vi.useRealTimers();
    throw cause;
  }
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.policySend.mockReset();
  mocks.policyTransportClose.mockReset();
  mocks.policyEvent = undefined;
  mocks.policySend.mockImplementation(async (method: string) =>
    policyResponse(method),
  );
  mocks.policyTransportClose.mockResolvedValue(undefined);
});

it.each(["abort signal", "explicit stop"])(
  "confirms attached navigation stop requested by %s before disconnecting",
  async (request) => {
    const { cleanup, page } = fixture();
    mocks.storage = undefined;
    const cancellation = new AbortController();
    const attached = browserScenarioSchema.parse({
      ...connectedScenario("block"),
      storage: {},
    });
    const session = await PlaywrightScenarioSession.open(
      attached,
      {},
      { signal: cancellation.signal },
    );

    const close = () =>
      session.close(request === "explicit stop" ? true : undefined);
    if (request === "abort signal") {
      cancellation.abort();
    } else {
      const failure = new Error("stopLoading rejected");
      mocks.policySend.mockRejectedValueOnce(failure);
      await expect(close()).rejects.toMatchObject({
        cause: failure,
        cleanupIncomplete: true,
      });
      expect(cleanup.close).not.toHaveBeenCalled();
    }

    await expect(close()).resolves.toBe("disconnected-external");
    expect(
      mocks.policySend.mock.calls.filter(
        ([method]) => method === "Page.stopLoading",
      ),
    ).toHaveLength(request === "abort signal" ? 1 : 2);
    expect(page.evaluate).not.toHaveBeenCalledWith("globalThis.stop()");
    expect(cleanup.close).toHaveBeenCalledTimes(1);
  },
);

it("assigns attached navigation stopping to the storage owner once", async () => {
  const { cleanup, storage } = fixture();
  const attached = connectedScenario("block");
  const session = await PlaywrightScenarioSession.open(attached, {}, {});

  await expect(session.close(true)).resolves.toBe("disconnected-external");
  expect(storage?.close).toHaveBeenCalledWith(true);
  expect(
    mocks.policySend.mock.calls.filter(
      ([method]) => method === "Page.stopLoading",
    ),
  ).toHaveLength(0);
  expect(cleanup.close).toHaveBeenCalledTimes(1);
});

it("transfers attached navigation stopping after storage cleanup fails", async () => {
  const { cleanup, storage } = fixture();
  const storageFailure = new Error("storage stop unconfirmed");
  storage?.close.mockRejectedValueOnce(storageFailure);
  const policyFailure = new Error("policy stop unconfirmed");
  const attached = connectedScenario("block");
  const session = await PlaywrightScenarioSession.open(attached, {}, {});
  mocks.policySend.mockRejectedValueOnce(policyFailure);

  await expect(session.close(true)).rejects.toMatchObject({
    cause: { errors: [policyFailure, storageFailure] },
    cleanupIncomplete: true,
  });
  expect(cleanup.close).not.toHaveBeenCalled();
  await expect(session.close()).resolves.toBe("disconnected-external");
  expect(storage?.close).toHaveBeenCalledWith(true);
  expect(
    mocks.policySend.mock.calls.filter(
      ([method]) => method === "Page.stopLoading",
    ),
  ).toHaveLength(2);
  expect(cleanup.close).toHaveBeenCalledTimes(1);
});

it("transfers a late stop request after storage has already released", async () => {
  const { cleanup, storage } = fixture();
  const cancellation = new AbortController();
  storage?.close.mockResolvedValue({ loadingStopped: false });
  const attached = connectedScenario("block");
  const session = await PlaywrightScenarioSession.open(
    attached,
    {},
    {
      signal: cancellation.signal,
    },
  );
  const restorationFailure = new Error("registration restoration failed");
  let failRestoration = true;
  mocks.policySend.mockImplementation(async (method: string) => {
    if (method === "Runtime.evaluate" && failRestoration) {
      failRestoration = false;
      throw restorationFailure;
    }
    return policyResponse(method);
  });

  await expect(session.close(false)).rejects.toMatchObject({
    cause: restorationFailure,
    cleanupIncomplete: true,
  });
  expect(cleanup.close).not.toHaveBeenCalled();
  cancellation.abort();
  await expect(session.close()).resolves.toBe("disconnected-external");
  expect(storage?.close.mock.calls).toEqual([[false]]);
  expect(
    mocks.policySend.mock.calls.filter(
      ([method]) => method === "Page.stopLoading",
    ),
  ).toHaveLength(1);
  expect(cleanup.close).toHaveBeenCalledTimes(1);
});

it.each([
  "in flight",
  "timed out with policy pending",
  "timed out with policy settled",
] as const)(
  "honors cancellation before disconnect when cleanup is %s",
  async (phase) => {
    const {
      storage,
      cancellation,
      session,
      restoration,
      transportClosed,
      transitions,
    } = await prepareHeldPolicyRestoration();
    vi.useFakeTimers();
    try {
      const firstClose = session.close(false).catch((cause: unknown) => cause);
      await restoration.reached(firstClose, "policy restoration");
      let failure: unknown;
      if (phase !== "in flight") {
        await vi.advanceTimersByTimeAsync(CDP_CLEANUP_GRACE_MS);
        failure = await firstClose;
        expect(failure).toMatchObject({ cleanupIncomplete: true });
      }
      expect(transitions).toEqual([]);

      if (phase === "timed out with policy settled") {
        restoration.release();
        await transportClosed;
        await vi.advanceTimersByTimeAsync(0);
      }
      cancellation.abort();
      const retry = session.close();
      restoration.release();
      await expect(retry).resolves.toBe("disconnected-external");
      if (phase === "in flight") {
        expect(await firstClose).toBe("disconnected-external");
      } else {
        expect(failure).toMatchObject({ cleanupIncomplete: false });
      }
    } finally {
      restoration.release();
      vi.useRealTimers();
      await session.close().catch(() => undefined);
    }

    expect(storage.close.mock.calls).toEqual([[false]]);
    expect(transitions).toEqual(["stop", "disconnect"]);
    expect(mocks.policyTransportClose).toHaveBeenCalledTimes(1);
  },
);

it("does not repeat a stop confirmed by storage during a late retry", async () => {
  const { cleanup, page, storage } = fixture();
  const cancellation = new AbortController();
  storage?.close.mockResolvedValue({ loadingStopped: true });
  const attached = connectedScenario("block");
  const session = await PlaywrightScenarioSession.open(
    attached,
    {},
    { signal: cancellation.signal },
  );
  const { promise: held, resolve: finishRestoration } = deferred();
  const { promise: started, resolve: restorationStarted } = deferred();
  mocks.policySend.mockImplementation(async (method: string) => {
    if (method === "Runtime.evaluate") {
      restorationStarted();
      await held;
    }
    return policyResponse(method);
  });

  const firstClose = session.close(false);
  try {
    await awaitAcknowledgement(started, firstClose, "policy restoration");
    cancellation.abort();
    const retry = session.close();
    finishRestoration();
    await expect(Promise.all([firstClose, retry])).resolves.toEqual([
      "disconnected-external",
      "disconnected-external",
    ]);

    expect(storage?.close).toHaveBeenCalledWith(false);
    expect(
      mocks.policySend.mock.calls.filter(
        ([method]) => method === "Page.stopLoading",
      ),
    ).toHaveLength(0);
    expect(
      page.evaluate.mock.calls.filter(
        ([script]) => script === "globalThis.stop()",
      ),
    ).toHaveLength(0);
    expect(cleanup.close).toHaveBeenCalledTimes(1);
  } finally {
    cancellation.abort();
    finishRestoration();
    try {
      await firstClose;
    } finally {
      await session.close();
    }
  }
});

it.each([
  {
    serviceWorkers: "block",
    phase: "event finalization",
    cancelAtRelease: false,
  },
  {
    serviceWorkers: "allow",
    phase: "event finalization",
    cancelAtRelease: false,
  },
  { serviceWorkers: "allow", phase: "browser release", cancelAtRelease: true },
] as const)(
  "transfers cancellation during $phase with service workers set to $serviceWorkers",
  async ({ serviceWorkers, cancelAtRelease }) => {
    const { cancellation, session, storage, transitions } =
      await prepareAttachedCleanup(serviceWorkers, cancelAtRelease);
    const events = phaseGate();
    mocks.finishEvents.mockImplementation(() => events.hold());
    const firstClose = session.close(false);
    try {
      await events.reached(firstClose, "final event cleanup");
      if (!cancelAtRelease) cancellation.abort();
      const retry = session.close(false);
      events.release();
      await expect(Promise.all([firstClose, retry])).resolves.toEqual([
        "disconnected-external",
        "disconnected-external",
      ]);
    } finally {
      events.release();
      await firstClose.catch(() => undefined);
    }

    expect(storage.close.mock.calls).toEqual([[false]]);
    expect(transitions).toEqual(["stop", "disconnect"]);
  },
);

it.each([false, true])(
  "stops an allowed-worker page during event finalization (failed first stop: %s)",
  async (failFirst) => {
    const { cleanup, page, storage } = fixture();
    if (!failFirst) mocks.storage = undefined;
    storage.close.mockResolvedValue({ loadingStopped: false });
    const cancellation = new AbortController();
    const session = await PlaywrightScenarioSession.open(
      connectedScenario("allow"),
      {},
      { signal: cancellation.signal },
    );
    const events = phaseGate();
    mocks.finishEvents.mockImplementation(() => events.hold());

    const failure = new Error("main frame stop failed");
    const failedStop = vi.fn(async () => {
      throw failure;
    });
    const stop = vi.fn(async () => undefined);
    const mainFrame = vi.spyOn(page, "mainFrame").mockReturnValue({
      isDetached: () => false,
      evaluate: stop,
    } as unknown as typeof page);
    if (failFirst)
      mainFrame.mockReturnValueOnce({
        isDetached: () => false,
        evaluate: failedStop,
      } as unknown as typeof page);

    const firstClose = session.close(false);
    try {
      await events.reached(firstClose, "final event cleanup");
      cancellation.abort();
      const concurrentClose = session.close(false);
      events.release();
      if (failFirst) {
        const outcomes = await Promise.allSettled([
          firstClose,
          concurrentClose,
        ]);
        const rejected = expect.objectContaining({
          status: "rejected",
          reason: expect.objectContaining({
            cause: failure,
            cleanupIncomplete: true,
          }),
        });
        expect(outcomes).toEqual([rejected, rejected]);
        expect(cleanup.browserClosed).toBe(false);
        await expect(session.close()).resolves.toBe("disconnected-external");
      } else {
        await expect(
          Promise.all([firstClose, concurrentClose]),
        ).resolves.toEqual(["disconnected-external", "disconnected-external"]);
      }
    } finally {
      events.release();
      await firstClose.catch(() => undefined);
    }
    expect(mocks.policySend).not.toHaveBeenCalled();
    expect(failedStop.mock.calls).toEqual(
      failFirst ? [["globalThis.stop()"]] : [],
    );
    expect(stop).toHaveBeenCalledExactlyOnceWith("globalThis.stop()");
    expect(storage.close.mock.calls).toEqual(failFirst ? [[false]] : []);
    expect(cleanup.close).toHaveBeenCalledTimes(failFirst ? 2 : 1);
  },
);

it("retains a late fallback stop failure for retry", async () => {
  const { page, session, transitions } = await prepareLateStopRetry();
  try {
    const stopFailure = new Error("late main-frame stop failed");
    const detachedFrame = {
      evaluate: vi.fn(async () => {
        throw stopFailure;
      }),
      isDetached: () => true,
    } as unknown as ReturnType<typeof page.mainFrame>;
    const freshFrame = {
      evaluate: vi.fn(async () => null),
      isDetached: () => false,
    } as unknown as ReturnType<typeof page.mainFrame>;
    vi.spyOn(page, "mainFrame")
      .mockReturnValueOnce(detachedFrame)
      .mockReturnValue(freshFrame);
    const failedRetry = session.close().then(
      () => ({ ok: true as const }),
      (cause: unknown) => ({ ok: false as const, cause }),
    );
    await expect(failedRetry).resolves.toMatchObject({
      ok: false,
      cause: { cleanupIncomplete: true },
    });
    expect(transitions).toEqual([]);

    await expect(session.close()).resolves.toBe("disconnected-external");
    expect(detachedFrame.evaluate).toHaveBeenCalledWith("globalThis.stop()");
    expect(freshFrame.evaluate).toHaveBeenCalledWith("globalThis.stop()");
  } finally {
    vi.useRealTimers();
  }

  expect(transitions).toEqual(["disconnect"]);
});

it("coalesces concurrent late-stop close retries", async () => {
  const { page, session, transitions } = await prepareLateStopRetry();
  try {
    const { promise: heldStop, resolve: finishStop } = deferred();
    const { promise: startedStop, resolve: stopStarted } = deferred();
    page.evaluate.mockImplementation(async (script: unknown) => {
      if (script === "globalThis.stop()") {
        stopStarted();
        await heldStop;
      }
      return null;
    });
    const firstRetry = session.close();
    await startedStop;
    const secondRetry = session.close();
    expect(
      page.evaluate.mock.calls.filter(
        ([script]) => script === "globalThis.stop()",
      ),
    ).toHaveLength(1);
    finishStop();
    await expect(Promise.all([firstRetry, secondRetry])).resolves.toEqual([
      "disconnected-external",
      "disconnected-external",
    ]);
  } finally {
    vi.useRealTimers();
  }

  expect(
    page.evaluate.mock.calls.filter(
      ([script]) => script === "globalThis.stop()",
    ),
  ).toHaveLength(1);
  expect(transitions).toEqual(["disconnect"]);
});

it("retains transferred navigation stopping after setup cleanup fails", async () => {
  const { cleanup, storage } = fixture();
  const cancellation = new AbortController();
  const setupFailure = new Error("storage initialization failed");
  storage?.initialize.mockImplementationOnce(async () => {
    cancellation.abort();
    throw setupFailure;
  });
  storage?.close.mockRejectedValueOnce(new Error("storage stop unconfirmed"));
  const policyFailure = new Error("policy stop unconfirmed");
  let failPolicyStop = true;
  mocks.policySend.mockImplementation(async (method: string) => {
    if (method === "Page.stopLoading" && failPolicyStop) {
      failPolicyStop = false;
      throw policyFailure;
    }
    return policyResponse(method);
  });
  let retainedCleanup: AnalysisCleanupLease | undefined;
  const attached = connectedScenario("block");

  await expect(
    PlaywrightScenarioSession.open(
      attached,
      {},
      {
        signal: cancellation.signal,
        retainCleanup: (close) => {
          retainedCleanup = close;
        },
      },
    ),
  ).rejects.toBeInstanceOf(AggregateError);
  expect(cleanup.close).not.toHaveBeenCalled();
  if (retainedCleanup === undefined)
    throw new Error("failed cleanup was not retained");
  await expect(retainedCleanup.release()).resolves.toBeUndefined();
  expect(
    mocks.policySend.mock.calls.filter(
      ([method]) => method === "Page.stopLoading",
    ),
  ).toHaveLength(2);
  expect(cleanup.close).toHaveBeenCalledTimes(1);
});

it("allows the bounded policy cleanup chain to cross one second", async () => {
  const { cleanup } = fixture();
  mocks.storage = undefined;
  const attached = connectedScenario("block", {});
  const session = await PlaywrightScenarioSession.open(attached, {}, {});
  const { promise: stopped, resolve: releaseStop } = deferred();
  const { promise: started, resolve: stopStarted } = deferred();
  mocks.policySend.mockImplementation(async (method: string) => {
    if (method === "Page.stopLoading") {
      stopStarted();
      await stopped;
    }
    return policyResponse(method);
  });

  vi.useFakeTimers();
  try {
    let settled = false;
    const closing = session.close(true).then(
      () => {
        settled = true;
        return { ok: true as const };
      },
      (cause: unknown) => {
        settled = true;
        return { ok: false as const, cause };
      },
    );
    await started;
    await vi.advanceTimersByTimeAsync(1_100);
    expect(settled).toBe(false);
    releaseStop();
    await expect(closing).resolves.toEqual({ ok: true });
  } finally {
    vi.useRealTimers();
  }
  expect(cleanup.close).toHaveBeenCalledTimes(1);
});

it("skips policy restoration for a child without a committed document", async () => {
  const { cleanup, page } = fixture();
  mocks.storage = undefined;
  const pendingChild = {
    url: () => "",
    isDetached: () => false,
    evaluate: vi.fn(() => new Promise(() => undefined)),
  };
  const session = await PlaywrightScenarioSession.open(
    connectedScenario("block", {}),
    {},
    {},
  );
  page.frames = () => [page, pendingChild as unknown as typeof page];

  await expect(session.close()).resolves.toBe("disconnected-external");
  expect(pendingChild.evaluate).not.toHaveBeenCalled();
  expect(cleanup.close).toHaveBeenCalledTimes(1);
});

it.each(["unprotected live realm", "failed auto-attach"])(
  "restores the installed policy before disconnect after %s",
  async (phase) => {
    const { page, cleanup } = fixture();
    const setupFailure = new Error("auto-attach rejected");
    if (phase === "unprotected live realm") {
      page.evaluate
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce("policy_unprotected");
    } else {
      mocks.policySend.mockImplementation(async (method: string) => {
        if (method === "Target.setAutoAttach") throw setupFailure;
        return policyResponse(method);
      });
    }
    const opening = PlaywrightScenarioSession.open(
      connectedScenario("block"),
      {},
      {},
    );
    if (phase === "unprotected live realm")
      await expect(opening).rejects.toMatchObject({
        reason: "target_not_allowed",
      });
    else await expect(opening).rejects.toBe(setupFailure);

    expect(mocks.policySend).toHaveBeenCalledWith(
      "Page.addScriptToEvaluateOnNewDocument",
      expect.objectContaining({ runImmediately: true }),
      "policy-session",
    );
    expect(mocks.policySend).toHaveBeenCalledWith(
      "Page.removeScriptToEvaluateOnNewDocument",
      { identifier: "owned-policy-script" },
      "policy-session",
    );
    expect(mocks.policySend).toHaveBeenCalledWith(
      "Runtime.evaluate",
      expect.objectContaining({
        expression: expect.stringContaining("policy_owned"),
      }),
      "policy-session",
    );
    expect(mocks.policyTransportClose).toHaveBeenCalledOnce();
    expect(cleanup.close).toHaveBeenCalledOnce();
  },
);

it.each(["detach notice", "missing-session rejection"])(
  "releases the parent policy when the child is retired by %s",
  async (retirement) => {
    const { cleanup } = fixture();
    const session = await PlaywrightScenarioSession.open(
      connectedScenario("block"),
      {},
      {},
    );
    const child = phaseGate();
    const notified = retirement === "detach notice";
    const childPhase = notified
      ? "Page.enable"
      : "Page.addScriptToEvaluateOnNewDocument";
    mocks.policySend.mockImplementation(
      async (method: string, _params: unknown, target: string) => {
        if (target === "child-session" && method === childPhase)
          await child.hold();
        if (
          target === "child-session" &&
          method === "Page.removeScriptToEvaluateOnNewDocument"
        )
          throw new CdpCommandRejection(
            "capture_browser_scenario",
            method,
            -32_001,
            "Session with given id not found.",
          );
        return policyResponse(method);
      },
    );
    mocks.policyEvent?.({
      method: "Target.attachedToTarget",
      params: { sessionId: "child-session", targetInfo: { type: "iframe" } },
      sessionId: "policy-session",
    });
    const closing = session.close();
    try {
      await child.reached(closing, "child policy acknowledgement");
      if (notified) {
        mocks.policyEvent?.({
          method: "Target.detachedFromTarget",
          params: { sessionId: "child-session" },
        });
        const pending = new Promise((resolve) =>
          setImmediate(() => resolve("still pending")),
        );
        await expect(Promise.race([closing, pending])).resolves.toBe(
          "disconnected-external",
        );
      } else {
        child.release();
        await expect(closing).resolves.toBe("disconnected-external");
      }
      const removals = mocks.policySend.mock.calls
        .filter(
          ([method]) => method === "Page.removeScriptToEvaluateOnNewDocument",
        )
        .map(([, params, target]) => [params.identifier, target])
        .sort();
      expect(removals).toEqual(
        notified
          ? [["owned-policy-script", "policy-session"]]
          : [
              ["owned-policy-script", "child-session"],
              ["owned-policy-script", "policy-session"],
            ],
      );
      expect(mocks.policySend).toHaveBeenCalledWith("Target.detachFromTarget", {
        sessionId: "policy-session",
      });
      expect(mocks.policyTransportClose).toHaveBeenCalledOnce();
      expect(cleanup.close).toHaveBeenCalledOnce();
    } finally {
      child.release();
      await closing.catch(() => undefined);
      await session.close();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    if (notified)
      expect(
        mocks.policySend.mock.calls
          .filter(([, , target]) => target === "child-session")
          .map(([method]) => method),
      ).toEqual(["Page.enable"]);
  },
);

it.each(["script removal", "realm restoration", "transport close"])(
  "retries policy cleanup after %s fails without repeating successful phases",
  async (phase) => {
    const { cleanup, storage } = fixture();
    if (phase === "realm restoration") mocks.storage = undefined;
    const session = await PlaywrightScenarioSession.open(
      phase === "realm restoration"
        ? connectedScenario("block", {})
        : connectedScenario("block"),
      {},
      {},
    );
    const afterSetup = mocks.policySend.mock.calls.length;
    const failure = new Error(`${phase} rejected`);
    if (phase === "transport close") {
      mocks.policyTransportClose.mockRejectedValueOnce(failure);
    } else {
      const blocked =
        phase === "script removal"
          ? "Page.removeScriptToEvaluateOnNewDocument"
          : "Runtime.evaluate";
      let attempted = false;
      mocks.policySend.mockImplementation(async (method: string) => {
        if (method === blocked && !attempted) {
          attempted = true;
          throw failure;
        }
        return policyResponse(method);
      });
    }

    const rejected = await session
      .close(phase === "realm restoration")
      .catch((cause: unknown) => cause);
    expect(rejected).toMatchObject({ cleanupIncomplete: true });
    if (!(rejected instanceof Error))
      throw new Error("Expected a cleanup error");
    const physical = rejected.cause;
    expect(
      phase === "transport close" ? (physical as Error).cause : physical,
    ).toBe(failure);
    expect(cleanup.close).not.toHaveBeenCalled();

    await expect(session.close()).resolves.toBe("disconnected-external");
    await expect(session.close()).resolves.toBe("disconnected-external");
    const calls = mocks.policySend.mock.calls.slice(afterSetup);
    const dispatched = (method: string) =>
      calls.filter(([name]) => name === method);
    expect(dispatched("Page.removeScriptToEvaluateOnNewDocument")).toEqual(
      Array.from({ length: phase === "script removal" ? 2 : 1 }, () => [
        "Page.removeScriptToEvaluateOnNewDocument",
        { identifier: "owned-policy-script" },
        "policy-session",
      ]),
    );
    expect(dispatched("Runtime.evaluate")).toHaveLength(
      phase === "realm restoration" ? 2 : 1,
    );
    expect(dispatched("Page.stopLoading")).toHaveLength(
      phase === "realm restoration" ? 1 : 0,
    );
    expect(dispatched("Target.detachFromTarget")).toEqual([
      ["Target.detachFromTarget", { sessionId: "policy-session" }],
    ]);
    expect(mocks.policyTransportClose).toHaveBeenCalledTimes(
      phase === "transport close" ? 2 : 1,
    );
    expect(storage.close).toHaveBeenCalledTimes(
      phase === "realm restoration" ? 0 : 1,
    );
    expect(cleanup.close).toHaveBeenCalledOnce();
  },
);

it.each(["closed page", "detached target"])(
  "releases its policy transport after a %s",
  async (terminal) => {
    const { page } = fixture();
    mocks.storage = undefined;
    const attached = connectedScenario("block", {});
    const session = await PlaywrightScenarioSession.open(attached, {}, {});
    if (terminal === "closed page") page.isClosed = () => true;
    else
      mocks.policyEvent?.({
        method: "Target.detachedFromTarget",
        params: { sessionId: "policy-session" },
      });
    await expect(session.close(true)).resolves.toBe("disconnected-external");
    expect(
      mocks.policySend.mock.calls.some(
        ([method]) => method === "Target.detachFromTarget",
      ),
    ).toBe(false);
    expect(mocks.policyTransportClose).toHaveBeenCalledTimes(1);
    if (terminal === "detached target") {
      expect(page.evaluate).toHaveBeenCalledWith("globalThis.stop()");
      expect(page.evaluate).toHaveBeenCalledWith(
        expect.stringContaining("policy_owned"),
      );
    }
  },
);

it("retains a detached policy connection until the main realm is restored", async () => {
  const { cleanup, page } = fixture();
  mocks.storage = undefined;
  const attached = connectedScenario("block", {});
  const session = await PlaywrightScenarioSession.open(attached, {}, {});
  mocks.policyEvent?.({
    method: "Target.detachedFromTarget",
    params: { sessionId: "policy-session" },
  });
  page.evaluate
    .mockResolvedValueOnce(undefined)
    .mockResolvedValueOnce("policy_owned")
    .mockResolvedValueOnce(null);

  await expect(session.close(true)).rejects.toMatchObject({
    cause: {
      message: expect.stringContaining(
        "service-worker policy restoration could not be confirmed",
      ),
    },
    cleanupIncomplete: true,
  });
  expect(cleanup.close).not.toHaveBeenCalled();
  expect(mocks.policyTransportClose).not.toHaveBeenCalled();
  await expect(session.close()).resolves.toBe("disconnected-external");
  expect(page.evaluate).toHaveBeenCalledWith("globalThis.stop()");
  expect(
    page.evaluate.mock.calls.filter(
      ([script]) => script === "globalThis.stop()",
    ),
  ).toHaveLength(1);
  expect(mocks.policyTransportClose).toHaveBeenCalledTimes(1);
  expect(cleanup.close).toHaveBeenCalledTimes(1);
});

// The policy owner records its lost connection when CDP reports it; the next
// step must report that before acting, since its documents would be
// unprotected.
it("refuses the next step after the policy session detaches", async () => {
  const { page } = fixture();
  const attached = browserScenarioSchema.parse({
    ...connectedScenario("block"),
    actions: [
      {
        step_id: "navigate",
        action: "goto",
        destination: { url: "https://other.example.test/" },
        wait_until: "load",
      },
    ],
  });
  const session = await PlaywrightScenarioSession.open(attached, {}, {});
  const [action] = attached.actions;
  if (action === undefined) throw new Error("Expected a scenario action");
  const navigations = page.goto.mock.calls.length;
  mocks.policyEvent?.({
    method: "Target.detachedFromTarget",
    params: { sessionId: "policy-session" },
  });

  await expect(session.perform(action)).rejects.toMatchObject({
    _tag: "BrowserObservationError",
    reason: "target_session_detached",
  });
  expect(page.goto).toHaveBeenCalledTimes(navigations);
  await session.close().catch(() => undefined);
});

it.each([
  { mode: "launch", late: "fulfilled" },
  { mode: "connect", late: "fulfilled" },
  { mode: "connect", late: "rejected" },
])(
  "releases a cancelled $mode session after $late cookie setup settles",
  async ({ mode, late }) => {
    const { context, page, opened, cleanup, storage } = fixture();
    const launched =
      mode === "launch"
        ? {
            closeBrowser: vi.fn(async () => undefined),
            removeProfile: vi.fn(async () => undefined),
          }
        : undefined;
    if (launched !== undefined)
      mocks.openBrowser.mockResolvedValue({
        ...opened,
        cleanup: new PlaywrightScenarioBrowserCleanupOwner(launched),
      });
    const close = launched?.closeBrowser ?? cleanup.close;
    const controller = new AbortController();
    const reason = { stop: "during cookie setup" };
    const cookies = phaseGate<void, undefined>();
    context.addCookies.mockImplementationOnce(() => cookies.hold());

    const input = browserScenarioSchema.parse({
      ...(mode === "launch" ? scenario : connectedScenario("allow")),
      storage: {
        cookies: [
          {
            name: "session",
            http_only: true,
            secure: true,
            same_site: "Lax",
            value: { source: "literal", value: "selected" },
            destination: { url: "https://storage.example.test/" },
          },
        ],
      },
    });
    const retainCleanup = vi.fn();
    const provider = new PlaywrightBrowserScenarioProvider(
      (scenario, options) =>
        PlaywrightScenarioSession.open(
          scenario,
          {},
          {
            ...options,
            retainCleanup: (...args) => {
              retainCleanup(...args);
              options.retainCleanup?.(...args);
            },
          },
        ),
    );
    const result = provider.captureScenario(input, {
      signal: controller.signal,
    });
    try {
      await cookies.reached(result, "cookie initialization");
      controller.abort(reason);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(close).not.toHaveBeenCalled();
      if (late === "rejected")
        cookies.reject(new Error("cookie acknowledgement rejected"));
      else cookies.release(undefined);

      const outcome = await result;
      if (outcome.ok)
        throw new Error("Expected cancelled cookie initialization");
      expect(outcome.error).toMatchObject({
        _tag: "AnalysisCancelledError",
        cleanupIncomplete: false,
      });
      expect(outcome.error.cause).toBe(reason);
      expect(close).toHaveBeenCalledOnce();
      if (launched !== undefined)
        expect(launched.removeProfile).toHaveBeenCalledOnce();
      expect(retainCleanup).not.toHaveBeenCalled();
      expect(storage.initialize).not.toHaveBeenCalled();
      expect(page.goto).not.toHaveBeenCalled();
    } finally {
      cookies.release(undefined);
      await result;
      await provider.close();
    }
  },
);

it("retries the same cleanup lease for a browser that opens after cancellation", async () => {
  const { opened, page } = fixture();
  const closing = phaseGate();
  const failure = new Error("transport close failed");
  const closeBrowser = vi
    .fn()
    .mockImplementationOnce(() => closing.hold())
    .mockResolvedValue(undefined);
  const removeProfile = vi.fn(async () => undefined);
  const lateOpened = {
    ...opened,
    cleanup: new PlaywrightScenarioBrowserCleanupOwner({
      closeBrowser,
      removeProfile,
    }),
  };
  const opening = phaseGate<void, typeof lateOpened>();
  mocks.openBrowser.mockImplementationOnce(() => opening.hold());
  const controller = new AbortController();
  const retained: AnalysisCleanupLease[] = [];
  const result = PlaywrightScenarioSession.open(
    scenario,
    {},
    {
      signal: controller.signal,
      retainCleanup: (lease) => retained.push(lease),
    },
  );
  try {
    await opening.reached(result, "browser opening");
    const cancelled = expect(result).rejects.toMatchObject({
      _tag: "AnalysisCancelledError",
    });
    controller.abort();
    await cancelled;
    expect(retained).toHaveLength(1);
    const lease = retained[0]!;
    opening.release(lateOpened);

    const firstClose = lease.release();
    await closing.reached(firstClose, "late transport cleanup");
    expect(removeProfile).not.toHaveBeenCalled();
    closing.reject(failure);
    await expect(firstClose).rejects.toBe(failure);
    expect(removeProfile).not.toHaveBeenCalled();
    await expect(lease.release()).resolves.toBeUndefined();
    expect(closeBrowser).toHaveBeenCalledTimes(2);
    expect(removeProfile).toHaveBeenCalledOnce();
    expect(page.goto).not.toHaveBeenCalled();
  } finally {
    controller.abort();
    opening.release(lateOpened);
    closing.release();
    const unexpectedSession = await result.catch(() => undefined);
    await unexpectedSession?.close();
    const recovery = retained[0] ?? lateOpened.cleanup.cleanupLease;
    await recovery.release().catch(() => recovery.release());
  }
});

it("leaves attached service-worker state alone when the policy allows it", async () => {
  const { cleanup, page } = fixture();
  const attached = connectedScenario("allow");
  const session = await PlaywrightScenarioSession.open(attached, {}, {});

  expect(mocks.openBrowser).toHaveBeenCalledWith(
    attached,
    {},
    expect.any(Object),
  );
  expect(page.evaluate).not.toHaveBeenCalled();
  expect(page.addInitScript).not.toHaveBeenCalled();
  await expect(session.close()).resolves.toBe("disconnected-external");
  expect(cleanup.close).toHaveBeenCalledTimes(1);
});

it("blocks new attached service-worker registration without removing existing registrations", async () => {
  const { cleanup, page } = fixture();
  const attached = connectedScenario("block");
  const session = await PlaywrightScenarioSession.open(attached, {}, {});

  expect(page.evaluate).toHaveBeenCalledTimes(3);
  const injection = mocks.policySend.mock.calls.find(
    ([method]) => method === "Page.addScriptToEvaluateOnNewDocument",
  )?.[1];
  expect(injection.source).toContain(
    "service workers are blocked by scenario policy",
  );
  expect(injection.source).not.toContain("getRegistrations");
  expect(injection.source).not.toContain("unregister");
  await expect(session.close()).resolves.toBe("disconnected-external");
  expect(mocks.policySend).toHaveBeenCalledWith(
    "Page.removeScriptToEvaluateOnNewDocument",
    { identifier: "owned-policy-script" },
    "policy-session",
  );
  expect(cleanup.close).toHaveBeenCalledTimes(1);
});

it.each(["preflight read", "script installation"])(
  "honors cancellation during the policy %s",
  async (phase) => {
    const { cleanup, page, storage } = fixture();
    const gate = phaseGate();
    const mutation = phase === "script installation";
    if (mutation) {
      mocks.policySend.mockImplementation(async (method: string) => {
        if (method === "Page.addScriptToEvaluateOnNewDocument")
          await gate.hold();
        return policyResponse(method);
      });
    } else {
      page.evaluate.mockImplementationOnce(async () => {
        await gate.hold();
        return null;
      });
    }
    const cancellation = new AbortController();
    const reason = new Error("cancelled during policy setup");
    const opening = PlaywrightScenarioSession.open(
      connectedScenario("block"),
      {},
      { signal: cancellation.signal },
    );
    const stopped = opening.catch((cause: unknown) => cause);
    const nextTurn = () =>
      new Promise<void>((resolve) => setImmediate(resolve));
    try {
      await gate.reached(opening, phase);
      cancellation.abort(reason);
      if (mutation) {
        await nextTurn();
        expect(cleanup.close).not.toHaveBeenCalled();
        expect(page.evaluate).toHaveBeenCalledOnce();
      } else {
        await expect(
          Promise.race([stopped, nextTurn()]),
        ).resolves.toMatchObject({
          _tag: "AnalysisCancelledError",
        });
        expect(cleanup.close).toHaveBeenCalledOnce();
      }
      gate.release();
      const failure = await stopped;
      expect(failure).toMatchObject({ _tag: "AnalysisCancelledError" });
      if (!(failure instanceof Error)) throw new Error("Expected cancellation");
      expect(failure.cause).toBe(reason);
      await nextTurn();

      if (mutation) {
        expect(mocks.policySend).toHaveBeenCalledWith(
          "Page.removeScriptToEvaluateOnNewDocument",
          { identifier: "owned-policy-script" },
          "policy-session",
        );
        expect(mocks.policySend).toHaveBeenCalledWith(
          "Runtime.evaluate",
          expect.objectContaining({
            expression: expect.stringContaining("policy_owned"),
          }),
          "policy-session",
        );
        expect(mocks.policySend).toHaveBeenCalledWith(
          "Page.stopLoading",
          {},
          "policy-session",
        );
      } else expect(mocks.policySend).not.toHaveBeenCalled();
      expect(cleanup.close).toHaveBeenCalledOnce();
      expect(storage.initialize).not.toHaveBeenCalled();
      expect(page.goto).not.toHaveBeenCalled();
    } finally {
      cancellation.abort();
      gate.release();
      const unexpectedSession = await opening.catch(() => undefined);
      await unexpectedSession?.close();
      await nextTurn();
    }
  },
);

it("rejects attached block when caller-owned registrations already exist", async () => {
  const { cleanup, page } = fixture();
  page.evaluate.mockResolvedValueOnce("service_worker_blocked");
  const attached = connectedScenario("block");

  await expect(
    PlaywrightScenarioSession.open(attached, {}, {}),
  ).rejects.toMatchObject({
    _tag: "BrowserObservationError",
    reason: "service_worker_blocked",
  });
  expect(mocks.policySend).not.toHaveBeenCalled();
  expect(page.goto).not.toHaveBeenCalled();
  expect(cleanup.close).toHaveBeenCalledTimes(1);
});

it.each([false, true])(
  "uses browser confirmation to retire storage after its cleanup fails (transport rejects: %s)",
  async (rejectTransport) => {
    const { cleanup, storage } = fixture();
    const storageFailure = new Error("CDP detach rejected");
    const transportFailure = new Error("Playwright transport close failed");
    storage.close.mockRejectedValueOnce(storageFailure);
    if (rejectTransport) cleanup.close.mockRejectedValueOnce(transportFailure);
    const session = await PlaywrightScenarioSession.open(scenario, {}, {});
    const firstClose = session.close();
    if (rejectTransport) {
      const rejected = await firstClose.catch((cause: unknown) => cause);
      expect(rejected).toMatchObject({
        cleanupIncomplete: true,
        cleanupResources: ["browser_transport"],
      });
      if (
        !(rejected instanceof Error && rejected.cause instanceof AggregateError)
      )
        throw new Error("Expected both physical cleanup errors");
      expect(rejected.cause.errors).toHaveLength(2);
      expect(rejected.cause.errors[0]).toBe(storageFailure);
      expect(rejected.cause.errors[1]).toBe(transportFailure);
      expect(cleanup.browserClosed).toBe(false);
      await expect(session.close()).resolves.toBe("terminated-owned-process");
      expect(rejected).toMatchObject({
        cleanupIncomplete: false,
        cleanupResources: [],
      });
    } else await expect(firstClose).resolves.toBe("terminated-owned-process");

    await expect(session.close()).resolves.toBe("terminated-owned-process");
    expect(cleanup.browserClosed).toBe(true);
    expect(storage.close).toHaveBeenCalledTimes(rejectTransport ? 2 : 1);
    expect(cleanup.close).toHaveBeenCalledTimes(rejectTransport ? 2 : 1);
    expect(mocks.finishEvents).toHaveBeenCalledOnce();
  },
);

it("expires the response at the cleanup deadline while retaining the same release", async () => {
  const { cleanup } = fixture();
  const session = await PlaywrightScenarioSession.open(scenario, {}, {});
  const browser = phaseGate();
  const release = vi.fn(async (finishEvents?: () => Promise<void>) => {
    await browser.hold();
    await cleanup.close(finishEvents);
  });
  cleanup.release = release;
  vi.useFakeTimers();
  try {
    const pending = session.close().catch((cause: unknown) => cause);
    await browser.reached(pending, "physical browser release");
    const outcome = () => Promise.race([pending, Promise.resolve("pending")]);
    await vi.advanceTimersByTimeAsync(29_999);
    await expect(outcome()).resolves.toBe("pending");

    await vi.advanceTimersByTimeAsync(1);
    const failure = await outcome();
    expect(failure).toMatchObject({
      cause: { _tag: "AnalysisTimeoutError", timeoutMs: 30_000 },
      cleanupIncomplete: true,
      cleanupResources: ["browser_transport"],
    });
    expect(session.cleanupLease.released).toBe(false);
    expect(cleanup.close).not.toHaveBeenCalled();
    const joining = session.cleanupLease.release();
    browser.release();
    await joining;
    expect(failure).toMatchObject({
      cleanupIncomplete: false,
      cleanupResources: [],
    });
    expect(release).toHaveBeenCalledOnce();
    expect(cleanup.close).toHaveBeenCalledOnce();
  } finally {
    browser.release();
    try {
      await session.cleanupLease.release();
    } finally {
      vi.useRealTimers();
    }
  }
});

it("retains late opening failure cleanup after cancellation until the exact profile lease recovers", async () => {
  let profileStarted: () => void = () => {};
  const profileAttempt = new Promise<void>((resolve) => {
    profileStarted = resolve;
  });
  let denied = true;
  const lease = new AnalysisCleanupLease(async () => {
    profileStarted();
    if (denied) throw new Error("authored profile removal denial");
  }, ["browser_profile"]);
  const failure = new ProviderCleanupError("fixture", ["browser_profile"], {
    reason: "late opening profile cleanup",
  });
  new AnalysisCleanupLeaseGroup(failure, [lease]);
  const launch = phaseGate();
  mocks.openBrowser.mockImplementation(
    async (
      _scenario: unknown,
      _env: unknown,
      options: { retainCleanup?: (lease: AnalysisCleanupLease) => void },
    ) => {
      await launch.hold();
      options.retainCleanup?.(lease);
      throw failure;
    },
  );
  const provider = new PlaywrightBrowserScenarioProvider((input, options) =>
    PlaywrightScenarioSession.open(input, {}, options),
  );
  const caller = new AbortController();
  const reason = { caller: "before late launch rejection" };
  try {
    const pending = provider.captureScenario(scenario, {
      signal: caller.signal,
    });
    await launch.reached(pending, "browser launch start");
    caller.abort(reason);
    const result = await pending;
    if (result.ok) throw new Error("Expected cancelled opening");
    expect(result.error.cleanupIncomplete).toBe(true);
    launch.release();
    await profileAttempt;
    await expect(provider.close()).rejects.toMatchObject({
      cleanupIncomplete: true,
    });
    expect(result.error).toMatchObject({
      cleanupIncomplete: true,
      cleanupResources: ["browser_profile"],
    });
    denied = false;
    await provider.close();
    expect(result.error).toMatchObject({
      cleanupIncomplete: false,
      cleanupResources: [],
    });
    expect(failure.cleanupIncomplete).toBe(false);
  } finally {
    caller.abort(reason);
    denied = false;
    launch.release();
    await provider.close();
  }
});

it.each([
  { mode: "launch", selected: undefined, deadline: 20_000 },
  { mode: "connect", selected: undefined, deadline: 20_000 },
  { mode: "launch", selected: 250, deadline: 250 },
  { mode: "connect", selected: 250, deadline: 250 },
] as const)(
  "bounds never-settling initial navigation in $mode mode with deadline $deadline and awaits cleanup",
  async ({ mode, selected, deadline }) => {
    vi.useFakeTimers();
    const { cleanup, page, storage } = fixture();
    const request = browserScenarioSchema.parse({
      ...(mode === "launch" ? scenario : connectedScenario("allow")),
      ...(selected === undefined ? {} : { command_timeout_ms: selected }),
    });
    page.goto.mockImplementation(() => new Promise<never>(() => {}));
    try {
      const opening = PlaywrightScenarioSession.open(request, {}, {}).catch(
        (cause: unknown) => cause,
      );
      await vi.advanceTimersByTimeAsync(deadline - 1);
      expect(cleanup.close).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      const failure = await opening;
      expect(failure).toMatchObject({
        _tag: "AnalysisTimeoutError",
        operation: "capture_browser_scenario",
        timeoutMs: deadline,
        partialObservation: {
          kind: "browser-scenario-observation",
          capture: {
            browser: {
              cleanup:
                mode === "launch"
                  ? "terminated-owned-process"
                  : "disconnected-external",
            },
            steps: [],
          },
        },
      });
      expect(cleanup.close).toHaveBeenCalledOnce();
      expect(storage?.close).toHaveBeenCalledWith(true);
      expect(page.goto).toHaveBeenCalledOnce();
    } finally {
      await cleanup.cleanupLease.release();
      vi.useRealTimers();
    }
  },
);

it.each([false, true])(
  "checks attached worker policy after final artifacts, worker takeover=%s",
  async (takeover) => {
    const { page, cleanup } = fixture();
    let controlled = false;
    let captures = 0;
    Object.assign(page, {
      waitForTimeout: vi.fn(async () => undefined),
      content: vi.fn(async () => {
        captures += 1;
        controlled = takeover && captures === 2;
        return controlled ? "<worker-response/>" : "<uncontrolled-response/>";
      }),
    });
    page.evaluate.mockImplementation(async (script: unknown) =>
      controlled &&
      typeof script === "string" &&
      script.includes("serviceWorker.controller")
        ? "service_worker_blocked"
        : null,
    );
    const input = browserScenarioSchema.parse({
      ...connectedScenario("block"),
      capture: { after_each_step: ["dom"], at_end: ["dom"], events: [] },
    });
    const provider = new PlaywrightBrowserScenarioProvider(
      (scenario, options) =>
        PlaywrightScenarioSession.open(scenario, {}, options),
    );
    try {
      const result = await provider.captureScenario(input, {});
      expect(captures).toBe(2);
      expect(cleanup.browserClosed).toBe(true);
      if (takeover) {
        if (result.ok)
          throw new Error("Expected final worker policy rejection");
        expect(projectAnalysisError(result.error)).toMatchObject({
          details: {
            diagnostics: {
              collected_artifacts: {
                dom: { value: { text: "<worker-response/>" } },
              },
            },
          },
        });
        expect(result.error).toMatchObject({
          reason: "service_worker_blocked",
          cleanupIncomplete: false,
          diagnostics: {
            collected_artifacts: {
              dom: { state: "captured", value: { text: "<worker-response/>" } },
            },
          },
          partialObservation: {
            capture: {
              browser: { cleanup: "disconnected-external" },
              steps: [{ action: "goto_start" }],
            },
          },
        });
      } else {
        if (!result.ok) throw result.error;
        expect(result.value.steps).toHaveLength(2);
        expect(result.value.steps[1]).toMatchObject({
          status: "completed",
          completeness: { status: "complete", equality_eligible: true },
        });
      }
    } finally {
      await provider.close();
    }
  },
);

it.each(["absent", "undefined", "inherited", "empty"] as const)(
  "resolves declared environment secrets before browser acquisition: %s",
  async (state) => {
    const { page } = fixture();
    Object.assign(page, { waitForTimeout: async () => undefined });
    const environment: Record<string, string | undefined> = {
      AVAILABLE_SECRET: "already-supplied-private-value",
    };
    if (state === "inherited")
      Object.setPrototypeOf(environment, {
        REQUIRED_SECRET: "inherited-value",
      });
    if (state === "undefined") environment.REQUIRED_SECRET = undefined;
    if (state === "empty") environment.REQUIRED_SECRET = "";
    const input = browserScenarioSchema.parse({
      ...scenario,
      secrets: [
        { secret_id: "available", environment_variable: "AVAILABLE_SECRET" },
        { secret_id: "required", environment_variable: "REQUIRED_SECRET" },
      ],
    });
    const provider = new PlaywrightBrowserScenarioProvider(
      (scenario, options) =>
        PlaywrightScenarioSession.open(scenario, environment, options),
    );
    try {
      const result = await provider.captureScenario(input, {});
      if (state === "empty") {
        if (!result.ok) throw result.error;
        expect(mocks.openBrowser).toHaveBeenCalledOnce();
      } else {
        if (result.ok) throw new Error("Expected unresolved environment input");
        const projected = projectAnalysisError(result.error);
        expect(projected).toMatchObject({
          code: "invalid_request",
          category: "invalid_input",
          details: {
            issues: [
              {
                path: ["secrets", 1, "environment_variable"],
                reason: "missing_argument",
                expected: {
                  secret_id: "required",
                  environment_variable: "REQUIRED_SECRET",
                },
              },
            ],
          },
        });
        expect(projected.message).toContain(
          "Set environment variable REQUIRED_SECRET",
        );
        expect(JSON.stringify(projected)).not.toContain(
          environment.AVAILABLE_SECRET,
        );
        expect(result.error.cleanupIncomplete).toBe(false);
        expect(mocks.openBrowser).not.toHaveBeenCalled();
      }
    } finally {
      await provider.close();
    }
  },
);

it("keeps declared secrets out of final cleanup and retry failure diagnostics", async () => {
  const { page, cleanup } = fixture();
  Object.assign(page, { waitForTimeout: vi.fn(async () => undefined) });
  const input = browserScenarioSchema.parse({
    ...connectedScenario("allow"),
    secrets: [
      {
        secret_id: "credential",
        environment_variable: "REA_SCENARIO_TEST_SECRET",
      },
    ],
    capture: { after_each_step: ["url"], at_end: [], events: [] },
  });
  const secret = "declared-cleanup-private-value";
  vi.spyOn(cleanup, "cleanupResources", "get").mockImplementation(() =>
    cleanup.browserClosed ? [] : [`browser_transport:${secret}`],
  );
  const originalClose = cleanup.close.getMockImplementation()!;
  let blocked = true;
  cleanup.close.mockImplementation(async (...args) => {
    if (blocked) throw new Error(`Close failed after ${secret}`);
    return originalClose(...args);
  });
  const provider = new PlaywrightBrowserScenarioProvider((scenario, options) =>
    PlaywrightScenarioSession.open(
      scenario,
      { REA_SCENARIO_TEST_SECRET: secret },
      options,
    ),
  );
  try {
    const result = await provider.captureScenario(input, {});
    if (result.ok) throw new Error("Expected final cleanup failure");
    expect(result.error.cleanupIncomplete).toBe(true);
    expect(result.error.partialObservation).toMatchObject({
      kind: "browser-scenario-observation",
      capture: {
        browser: { cleanup: "incomplete" },
        steps: [{ action: "goto_start" }, { action: "wait_for_timeout" }],
      },
    });
    expect(JSON.stringify(projectAnalysisError(result.error))).not.toContain(
      secret,
    );
    let retried: unknown;
    try {
      await provider.close();
    } catch (error) {
      retried = error;
    }
    if (!(retried instanceof ProviderCleanupError))
      throw new Error("Expected retained cleanup failure");
    expect(JSON.stringify(projectAnalysisError(retried))).not.toContain(secret);
    blocked = false;
    await provider.close();
    expect(cleanup.browserClosed).toBe(true);
    expect(result.error.cleanupIncomplete).toBe(false);
  } finally {
    blocked = false;
    await provider.close();
  }
});

it("projects both request and route cleanup failures with declared secrets redacted", async () => {
  const { page } = fixture();
  const secret = "private-request-diagnostic-value";
  const route = vi.fn(async () => undefined);
  const unroute = vi.fn(async () => {
    throw new Error(`page.unroute: closed ${secret}`);
  });
  Object.assign(page, {
    url: () => "https://app.example.test/",
    route,
    unroute,
  });
  const input = browserScenarioSchema.parse({
    ...connectedScenario("allow"),
    start_url: { url: "https://app.example.test/" },
    actions: [
      { step_id: "request", action: "request", method: "POST", path: "/api" },
    ],
    secrets: [
      { secret_id: "credential", environment_variable: "REQUEST_SECRET" },
    ],
    capture: { after_each_step: ["url"], at_end: [], events: [] },
  });
  const provider = new PlaywrightBrowserScenarioProvider((scenario, options) =>
    PlaywrightScenarioSession.open(
      scenario,
      { REQUEST_SECRET: secret },
      options,
    ),
  );
  page.evaluate.mockRejectedValue(new Error(`page.evaluate: closed ${secret}`));
  try {
    const result = await provider.captureScenario(input, {});
    if (!result.ok) throw result.error;
    const step = result.value.steps.find((step) => step.step_id === "request");
    expect(step).toMatchObject({ status: "failed" });
    expect(step?.error).toContain("page.evaluate: closed");
    expect(step?.error).toContain("page.unroute: closed");
    expect(JSON.stringify(result.value)).not.toContain(secret);
    expect(unroute).toHaveBeenCalledOnce();
  } finally {
    await provider.close();
  }
});
