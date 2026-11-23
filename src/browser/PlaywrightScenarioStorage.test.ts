import { EventEmitter } from "node:events";

import { expect, it, onTestFinished, vi } from "vitest";

import { browserScenarioSchema } from "../domain/browserScenario.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { BrowserObservationError } from "../domain/browserObservationError.js";
import { waitFor } from "../../tests/support/testWait.js";
import { resolveScenarioSecrets } from "../../tests/fixtures/browserScenarioSecrets.js";
import { PlaywrightScenarioStorage } from "./PlaywrightScenarioStorage.js";

class FakeCdp extends EventEmitter {
  readonly calls: { readonly method: string; readonly params?: unknown }[] = [];
  storageKey = "https://storage.example.test";
  frameTree: unknown = {
    frame: { id: "root-frame", securityOrigin: "https://storage.example.test" },
  };
  failDetachCount = 0;
  holdDetach = false;
  resolveDetach: (() => void) | undefined;
  holdMethod: string | undefined;
  heldReply: (() => void) | undefined;
  autoReplyNested = false;
  readonly pendingNested: {
    readonly sessionId: string;
    readonly id: number;
    readonly method: string;
    readonly params?: unknown;
  }[] = [];
  detachCalls = 0;

  async send(method: string, params?: unknown): Promise<unknown> {
    this.calls.push({ method, params });
    if (method === "Target.sendMessageToTarget") {
      const { sessionId, message } = params as {
        sessionId: string;
        message: string;
      };
      const command = JSON.parse(message) as {
        id: number;
        method: string;
        params?: unknown;
      };
      this.pendingNested.push({ sessionId, ...command });
      if (this.autoReplyNested)
        this.replyNested(sessionId, command.id, this.resultFor(command.method));
    }
    const result = this.resultFor(method);
    if (method === this.holdMethod) {
      return new Promise((resolve) => {
        this.heldReply = () => resolve(result);
      });
    }
    return result;
  }

  private resultFor(method: string): object {
    if (method === "Target.getTargetInfo")
      return { targetInfo: { targetId: "root-target" } };
    if (method === "Debugger.setBreakpointByUrl")
      return { breakpointId: "breakpoint" };
    if (method === "Page.addScriptToEvaluateOnNewDocument")
      return { identifier: "script" };
    if (method === "Storage.getStorageKey")
      return { storageKey: this.storageKey };
    if (method === "Page.getFrameTree") return { frameTree: this.frameTree };
    if (method === "Debugger.evaluateOnCallFrame")
      return { result: { type: "undefined" } };
    return {};
  }

  async detach(): Promise<void> {
    this.detachCalls += 1;
    if (this.failDetachCount > 0) {
      this.failDetachCount -= 1;
      throw new Error("one-shot CDP detach failure");
    }
    if (this.holdDetach)
      await new Promise<void>((resolve) => {
        this.resolveDetach = resolve;
      });
  }

  releaseHeldReply(): void {
    this.heldReply?.();
    this.heldReply = undefined;
    this.holdMethod = undefined;
  }

  releaseDetach(): void {
    this.holdDetach = false;
    this.resolveDetach?.();
    this.resolveDetach = undefined;
  }

  replyNested(sessionId: string, id: number, result = {}): void {
    queueMicrotask(() => this.emitNested(sessionId, { id, result }));
  }

  emitNested(sessionId: string, message: object): void {
    this.emit("Target.receivedMessageFromTarget", {
      sessionId,
      message: JSON.stringify(message),
    });
  }
}

const scenario = () =>
  browserScenarioSchema.parse({
    browser: { mode: "launch", executable_path: process.execPath },
    start_url: { url: "https://storage.example.test/" },
    actions: [{ step_id: "wait", action: "wait_for_timeout", duration_ms: 1 }],
    storage: {
      local_storage: [
        {
          origin: "https://storage.example.test",
          entries: [
            {
              name: "local-seed",
              value: { source: "literal", value: "local-value" },
            },
          ],
        },
      ],
      session_storage: [
        {
          origin: "https://storage.example.test",
          entries: [
            {
              name: "session-seed",
              value: { source: "literal", value: "session-value" },
            },
          ],
        },
      ],
    },
  });

const fixture = (cdp: FakeCdp) => {
  const page = new EventEmitter();
  const context = new EventEmitter();
  const browser = new EventEmitter();
  return {
    page,
    context,
    browser,
    contextApi: Object.assign(context, {
      browser: () => browser,
      newCDPSession: async () => cdp,
    }),
  };
};

const waitForCall = (cdp: FakeCdp, method: string) =>
  waitFor(
    () => expect(cdp.calls.map((call) => call.method)).toContain(method),
    { interval: 1 },
  );

const storageCleanupDeadlineMs = 1_000;

const useStorageClock = () => {
  vi.useFakeTimers();
  onTestFinished(() => void vi.useRealTimers());
};

const createInitializedStorage = async (
  context: ReturnType<typeof fixture>["contextApi"],
  page: ReturnType<typeof fixture>["page"],
  input = scenario(),
  options: { readonly signal?: AbortSignal } = {},
) => {
  const owner = await PlaywrightScenarioStorage.create(
    { context: context as never, page: page as never },
    input,
    resolveScenarioSecrets(input, {}),
    options,
  );
  await owner?.initialize(page as never, context as never);
  return owner;
};

const emitSeedPause = (
  cdp: FakeCdp,
  origin = "https://storage.example.test",
  sessionId?: string,
): void => {
  const addScript = cdp.calls.find(
    ({ method }) => method === "Page.addScriptToEvaluateOnNewDocument",
  );
  if (addScript === undefined)
    throw new Error("Storage seed script is missing");
  const sourceUrl = (addScript.params as { readonly worldName: string })
    .worldName;
  const emit = (method: string, params: object): void => {
    if (sessionId === undefined) cdp.emit(method, params);
    else cdp.emitNested(sessionId, { method, params });
  };
  emit("Runtime.executionContextCreated", {
    context: {
      id: 4,
      origin,
      name: sourceUrl,
      auxData: { frameId: "root-frame" },
    },
  });
  emit("Debugger.scriptParsed", {
    scriptId: "seed-script",
    executionContextId: 4,
    url: sourceUrl,
  });
  emit("Debugger.paused", {
    callFrames: [
      {
        callFrameId: "seed-frame",
        location: { scriptId: "seed-script" },
      },
    ],
  });
};

it("seeds each local partition and each top-level session before resuming its script", async () => {
  const cdp = new FakeCdp();
  const { page, contextApi } = fixture(cdp);
  const base = scenario();
  const origin = "https://storage.example.test";
  const sessionOnly = "https://session.example.test";
  const input = browserScenarioSchema.parse({
    ...base,
    storage: {
      ...base.storage,
      session_storage: [
        ...base.storage.session_storage,
        ...base.storage.session_storage.map((seed) => ({
          ...seed,
          origin: sessionOnly,
        })),
      ],
    },
  });
  const owner = await createInitializedStorage(contextApi, page, input);
  if (owner === undefined) throw new Error("Expected storage owner");
  const attach = (type: string, sessionId = type): void => {
    cdp.emit("Target.attachedToTarget", {
      sessionId,
      targetInfo: { type, targetId: `${sessionId}-target` },
    });
  };
  attach("iframe", "navigated-away-iframe");
  await waitForCall(cdp, "Target.sendMessageToTarget");
  cdp.emit("Target.detachedFromTarget", { sessionId: "navigated-away-iframe" });
  await owner.settle();
  cdp.autoReplyNested = true;

  cdp.emit("Debugger.paused", {
    callFrames: [
      { callFrameId: "caller-frame", location: { scriptId: "caller-script" } },
    ],
  });
  await owner.settle();
  const rootWrites = () =>
    cdp.calls.filter(({ method }) => method === "Debugger.evaluateOnCallFrame");
  const resumes = () =>
    cdp.calls.filter(({ method }) => method === "Debugger.resume");
  expect(rootWrites()).toEqual([]);
  expect(resumes()).toEqual([]);

  for (const key of [
    origin,
    origin,
    `${origin}/^0https://top-level.example`,
    sessionOnly,
  ]) {
    cdp.storageKey = key;
    emitSeedPause(cdp, key === sessionOnly ? sessionOnly : origin);
    await owner.settle();
  }
  const local = '"local":[["local-seed","local-value"]]';
  const session = '"session":[["session-seed","session-value"]]';
  expect(rootWrites().map(({ params }) => params)).toMatchObject([
    {
      callFrameId: "seed-frame",
      expression: expect.stringContaining(`${local},${session}`),
    },
    {
      callFrameId: "seed-frame",
      expression: expect.stringContaining(`${local},${session}`),
    },
    {
      callFrameId: "seed-frame",
      expression: expect.stringContaining(`"local":[],${session}`),
    },
  ]);
  expect(
    cdp.calls.findIndex(
      ({ method }) => method === "Debugger.evaluateOnCallFrame",
    ),
  ).toBeLessThan(
    cdp.calls.findIndex(({ method }) => method === "Debugger.resume"),
  );

  cdp.storageKey = origin;
  for (const type of ["iframe", "page"]) {
    attach(type);
    await owner.settle();
    emitSeedPause(cdp, origin, type);
    await owner.settle();
  }
  expect(
    cdp.pendingNested.filter(
      ({ method }) => method === "Debugger.evaluateOnCallFrame",
    ),
  ).toMatchObject([
    {
      sessionId: "page",
      params: { expression: expect.stringContaining(`"local":[],${session}`) },
    },
  ]);
  await owner.close();
  expect(cdp.detachCalls).toBe(1);
});

it.each([
  {
    label: "inherited origin",
    frameTree: {
      frame: {
        id: "other-frame",
        securityOrigin: "https://other.example.test",
      },
      childFrames: [
        {
          frame: {
            id: "root-frame",
            url: "about:blank",
            securityOrigin: "https://storage.example.test",
          },
        },
      ],
    },
    methods: [
      "Page.getFrameTree",
      "Storage.getStorageKey",
      "Debugger.evaluateOnCallFrame",
      "Debugger.resume",
    ],
  },
  {
    label: "unseeded origin",
    origin: "https://unseeded.example.test",
    methods: ["Debugger.resume"],
  },
  ...[
    {
      label: "wrong frame",
      frameTree: {
        frame: {
          id: "other-frame",
          securityOrigin: "https://storage.example.test",
        },
      },
    },
    {
      label: "URL alone",
      frameTree: {
        frame: { id: "root-frame", url: "https://storage.example.test/" },
      },
    },
    {
      label: "empty security origin",
      frameTree: { frame: { id: "root-frame", securityOrigin: "" } },
    },
    {
      label: "malformed tree",
      frameTree: undefined,
      message:
        "CDP Page.getFrameTree returned a malformed result at /frameTree",
    },
  ].map((row) => ({
    ...row,
    fails: true,
    methods: ["Page.getFrameTree", "Debugger.resume"],
  })),
])("resolves storage applicability for $label before resuming", async (row) => {
  const cdp = new FakeCdp();
  if ("frameTree" in row) cdp.frameTree = row.frameTree;
  const { page, contextApi } = fixture(cdp);
  const owner = await createInitializedStorage(contextApi, page);
  if (owner === undefined) throw new Error("Expected storage owner");
  const beforePause = cdp.calls.length;
  emitSeedPause(cdp, "origin" in row ? row.origin : "");
  if ("fails" in row) {
    const error = await owner.settle().catch((cause: unknown) => cause);
    if (!(error instanceof BrowserObservationError))
      throw new Error("Expected a storage protocol failure");
    expect(error.reason).toBe("protocol_error");
    if (row.message !== undefined)
      expect(projectAnalysisError(error).message).toContain(row.message);
  } else await owner.settle();
  expect(cdp.calls.slice(beforePause).map(({ method }) => method)).toEqual(
    row.methods,
  );
  await owner.close();
});

it.each(["launch", "connect"] as const)(
  "retains unknown popup seed coverage in %s mode without claiming root failure",
  async (mode) => {
    const cdp = new FakeCdp();
    const { page, contextApi } = fixture(cdp);
    const input = browserScenarioSchema.parse({
      ...scenario(),
      ...(mode === "connect"
        ? {
            browser: {
              mode: "connect",
              cdp_endpoint: "http://127.0.0.1:9222",
              target_id: "root-target",
            },
          }
        : {}),
    });
    const owner = await createInitializedStorage(contextApi, page, input);
    emitSeedPause(cdp);
    await owner?.settle();
    expect(owner?.limitations()).toEqual([]);
    if (mode === "connect") {
      contextApi.emit("page", new EventEmitter());
      expect(owner?.limitations()).toEqual([]);
      page.emit("popup", new EventEmitter());
    } else {
      contextApi.emit("page", page);
      expect(owner?.limitations()).toEqual([]);
      contextApi.emit("page", new EventEmitter());
    }
    expect(owner?.limitations()).toEqual([
      expect.stringContaining(
        "unknown for discovered popup top-level contexts",
      ),
    ]);
    await owner?.close();
    expect(owner?.limitations()).toHaveLength(1);
    expect(contextApi.listenerCount("page")).toBe(0);
    expect(page.listenerCount("popup")).toBe(0);
  },
);

it("retries the owning CDP detach after a failed attempt", async () => {
  const cdp = new FakeCdp();
  const { page, contextApi } = fixture(cdp);
  const owner = await createInitializedStorage(contextApi, page);
  cdp.failDetachCount = 1;

  await expect(owner?.close(true)).rejects.toMatchObject({
    _tag: "BrowserObservationError",
    reason: "cleanup_failed",
  });
  expect(cdp.detachCalls).toBe(1);
  expect(cdp.listenerCount("Debugger.paused")).toBe(1);

  await expect(owner?.close(true)).resolves.toEqual({
    loadingStopped: true,
  });
  await expect(owner?.close(true)).resolves.toEqual({ loadingStopped: true });
  expect(cdp.detachCalls).toBe(2);
  expect(cdp.listenerCount("Debugger.paused")).toBe(0);
  expect(
    cdp.calls.filter(({ method }) => method === "Page.stopLoading"),
  ).toHaveLength(1);
});

it("reports an unconfirmed stop when root initialization is still pending", async () => {
  const cdp = new FakeCdp();
  cdp.holdMethod = "Target.getTargetInfo";
  const { page, contextApi } = fixture(cdp);
  const input = scenario();
  const owner = await PlaywrightScenarioStorage.create(
    { context: contextApi as never, page: page as never },
    input,
    resolveScenarioSecrets(input, {}),
  );
  const initialization = owner?.initialize(page as never, contextApi as never);
  await waitForCall(cdp, "Target.getTargetInfo");

  const closing = owner?.close(true);
  cdp.releaseHeldReply();
  await expect(initialization).resolves.toBeUndefined();
  await expect(closing).resolves.toEqual({ loadingStopped: false });
  expect(
    cdp.calls.filter(({ method }) => method === "Page.stopLoading"),
  ).toHaveLength(0);
  expect(cdp.detachCalls).toBe(1);
});

it("does not create storage instrumentation when there are no storage seeds", async () => {
  const cdp = new FakeCdp();
  const { page, contextApi } = fixture(cdp);
  const empty = browserScenarioSchema.parse({
    browser: { mode: "launch", executable_path: process.execPath },
    start_url: { url: "https://storage.example.test/" },
    actions: [{ step_id: "wait", action: "wait_for_timeout", duration_ms: 1 }],
  });
  expect(
    await PlaywrightScenarioStorage.create(
      { context: contextApi as never, page: page as never },
      empty,
      resolveScenarioSecrets(empty, {}),
    ),
  ).toBeUndefined();
  expect(cdp.calls).toEqual([]);
});

it("detaches after setup cancellation even while script installation is pending", async () => {
  const cdp = new FakeCdp();
  cdp.holdMethod = "Page.addScriptToEvaluateOnNewDocument";
  const { page, contextApi } = fixture(cdp);
  const input = scenario();
  const controller = new AbortController();
  const owner = await PlaywrightScenarioStorage.create(
    { context: contextApi as never, page: page as never },
    input,
    resolveScenarioSecrets(input, {}),
    { signal: controller.signal },
  );
  const initialization = owner?.initialize(page as never, contextApi as never);
  await waitForCall(cdp, "Page.addScriptToEvaluateOnNewDocument");
  controller.abort();
  await expect(initialization).rejects.toMatchObject({
    _tag: "AnalysisCancelledError",
  });

  useStorageClock();
  const closing = owner?.close();
  await vi.advanceTimersByTimeAsync(storageCleanupDeadlineMs);
  expect(cdp.detachCalls).toBe(1);
  await closing;
  expect(
    cdp.calls.some(
      ({ method }) => method === "Page.removeScriptToEvaluateOnNewDocument",
    ),
  ).toBe(false);
  cdp.releaseHeldReply();
});

it("cancels a pending storage-key reply and still releases its CDP owner", async () => {
  const cdp = new FakeCdp();
  const { page, contextApi } = fixture(cdp);
  const input = scenario();
  const controller = new AbortController();
  const owner = await createInitializedStorage(contextApi, page, input, {
    signal: controller.signal,
  });
  cdp.holdMethod = "Storage.getStorageKey";
  emitSeedPause(cdp);
  const settling = owner?.settle();
  await waitForCall(cdp, "Storage.getStorageKey");
  controller.abort();
  await expect(settling).rejects.toMatchObject({
    _tag: "AnalysisCancelledError",
  });

  cdp.releaseHeldReply();
  await owner?.close();
  expect(cdp.detachCalls).toBe(1);
});

it.each(["command", "cleanup"] as const)(
  "bounds a stalled child reply by the %s deadline",
  async (phase) => {
    const cdp = new FakeCdp();
    const { page, contextApi } = fixture(cdp);
    const input = browserScenarioSchema.parse({
      ...scenario(),
      ...(phase === "command" ? { command_timeout_ms: 40 } : {}),
    });
    const owner = await createInitializedStorage(contextApi, page, input);
    if (owner === undefined) throw new Error("Expected storage owner");
    useStorageClock();
    cdp.emit("Target.attachedToTarget", {
      sessionId: "iframe-session",
      targetInfo: { type: "iframe", targetId: "iframe-target" },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(cdp.pendingNested).toHaveLength(1);
    if (phase === "command") {
      const settling = owner.settle().catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(40);
      const resume = cdp.pendingNested[1];
      if (resume === undefined)
        throw new Error("Expected debugger resume after command timeout");
      cdp.replyNested(resume.sessionId, resume.id);
      expect(await settling).toMatchObject({
        _tag: "BrowserObservationError",
        operation: "capture_browser_scenario",
        reason: "timeout",
        userMessage: expect.stringContaining(
          "CDP command Page.enable exceeded its 40 ms command_timeout_ms",
        ),
        remediationAction: expect.stringContaining(
          "Set command_timeout_ms in the capture-browser-scenario JSON above 40",
        ),
      });
      await owner.close();
      return;
    }
    const closing = owner.close();
    await vi.advanceTimersByTimeAsync(storageCleanupDeadlineMs - 1);
    expect(cdp.detachCalls).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(cdp.detachCalls).toBe(1);
    await closing;
  },
);

it("retains the exact in-flight detach after the bounded wait expires", async () => {
  const cdp = new FakeCdp();
  const { page, contextApi } = fixture(cdp);
  const owner = await createInitializedStorage(contextApi, page);
  cdp.holdDetach = true;

  useStorageClock();
  const first = owner?.close().catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(0);
  expect(cdp.detachCalls).toBe(1);
  await vi.advanceTimersByTimeAsync(storageCleanupDeadlineMs);
  expect(
    await Promise.race([first, Promise.resolve("still pending")]),
  ).toMatchObject({
    _tag: "BrowserObservationError",
    reason: "cleanup_failed",
  });
  const retry = owner?.close();
  await vi.advanceTimersByTimeAsync(0);
  expect(cdp.detachCalls).toBe(1);
  cdp.releaseDetach();
  await retry;
  expect(cdp.detachCalls).toBe(1);
});

it.each([
  [
    "Runtime.executionContextCreated",
    { context: { id: 4, origin: "https://storage.example.test", name: 7 } },
  ],
  [
    "Runtime.executionContextCreated",
    {
      context: {
        id: 4,
        origin: "https://storage.example.test",
        name: "seed",
        auxData: { frameId: 3 },
      },
    },
  ],
  ["Runtime.executionContextDestroyed", { executionContextId: "4" }],
  ["Debugger.scriptParsed", { scriptId: "seed-script", url: "seed" }],
  ["Debugger.paused", { callFrames: [{ callFrameId: "frame" }] }],
  ["Target.detachedFromTarget", {}],
] as const)(
  "records a malformed %s payload as a protocol failure",
  async (method, params) => {
    const cdp = new FakeCdp();
    const { page, contextApi } = fixture(cdp);
    const owner = await createInitializedStorage(contextApi, page);
    cdp.emit(method, params);
    await expect(owner?.settle()).rejects.toMatchObject({
      reason: "protocol_error",
    });
    await owner?.close();
  },
);
