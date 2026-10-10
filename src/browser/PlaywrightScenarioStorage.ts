import { randomUUID } from "node:crypto";

import { z } from "zod";
import type { BrowserContext, CDPSession, Page } from "playwright-core";

import type { BrowserScenario } from "../domain/browserScenario.js";
import { BrowserObservationError } from "../domain/browserObservationError.js";
import type { BrowserScenarioSecrets } from "./BrowserScenarioSecrets.js";
import { withPlaywrightExecutionBoundary } from "./PlaywrightExecutionBoundary.js";
import { failBrowserScenarioOperation } from "./PlaywrightScenarioBrowser.js";

const stringReply = (name: string) => z.object({ [name]: z.string() });
const attachedEvent = z.object({
  sessionId: z.string(),
  targetInfo: z.object({ type: z.string() }),
});
const detachedEvent = z.object({ sessionId: z.string() });
const messageEvent = z.object({ sessionId: z.string(), message: z.string() });
const protocolMessage = z.object({
  id: z.number().optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.object({ message: z.string() }).optional(),
});
const contextEvent = z.object({
  context: z.object({
    id: z.number(),
    origin: z.string(),
    name: z.string(),
    auxData: z.object({ frameId: z.string().optional() }).optional(),
  }),
});
const scriptEvent = z.object({
  scriptId: z.string(),
  executionContextId: z.number(),
  url: z.string(),
});
const pausedEvent = z.object({
  callFrames: z.array(
    z.object({
      callFrameId: z.string(),
      location: z.object({ scriptId: z.string() }),
    }),
  ),
});
const evaluationReply = z.object({ exceptionDetails: z.unknown().optional() });

interface StorageTarget {
  readonly parentId: string | undefined;
  readonly send: (
    method: string,
    params?: Record<string, unknown>,
  ) => Promise<unknown>;
  readonly contexts: Map<number, z.infer<typeof contextEvent>["context"]>;
  readonly scripts: Map<string, number>;
  ready: Promise<void>;
  script: string | undefined;
  breakpoint: string | undefined;
}

/** Initialize each real storage area before the first application script. */
export class PlaywrightScenarioStorage {
  private readonly seeds = new Map<
    string,
    { local: string[][]; session: string[][] }
  >();
  private readonly initialized = new Set<string>();
  private readonly targets = new Map<string, StorageTarget>();
  private readonly replies = new Map<
    number,
    {
      sessionId: string;
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }
  >();
  private readonly sourceUrl = `rea-storage-${randomUUID()}`;
  private sequence = 0;
  private closed = false;
  private failure: BrowserObservationError | undefined;
  private closePromise: Promise<void> | undefined;
  private removeListeners: () => void = () => undefined;
  private work: Promise<void> = Promise.resolve();

  private constructor(private readonly cdp: CDPSession) {}

  static async install(
    context: BrowserContext,
    page: Page,
    scenario: BrowserScenario,
    secrets: BrowserScenarioSecrets,
    retainCleanup?: (close: () => Promise<unknown>) => void,
  ): Promise<PlaywrightScenarioStorage | undefined> {
    if (
      scenario.storage.local_storage.length === 0 &&
      scenario.storage.session_storage.length === 0
    )
      return undefined;
    const owner = new PlaywrightScenarioStorage(
      await context.newCDPSession(page),
    );
    for (const [kind, blocks] of [
      ["local", scenario.storage.local_storage],
      ["session", scenario.storage.session_storage],
    ] as const)
      for (const { origin, entries } of blocks) {
        const seed = owner.seeds.get(origin) ?? { local: [], session: [] };
        seed[kind].push(
          ...entries.map(({ name, value }) => [name, secrets.value(value)]),
        );
        owner.seeds.set(origin, seed);
      }
    const target = owner.target(undefined, (method, params) =>
      owner.cdp.send(method as Parameters<CDPSession["send"]>[0], params),
    );
    owner.targets.set("", target);
    const disconnected = (): void => owner.detached("");
    page.on("close", disconnected);
    context.on("close", disconnected);
    const browser = context.browser();
    browser?.on("disconnected", disconnected);
    owner.removeListeners = () => {
      page.off("close", disconnected);
      context.off("close", disconnected);
      browser?.off("disconnected", disconnected);
    };
    for (const method of [
      "Runtime.executionContextCreated",
      "Runtime.executionContextDestroyed",
      "Runtime.executionContextsCleared",
      "Debugger.scriptParsed",
      "Debugger.paused",
      "Target.attachedToTarget",
      "Target.detachedFromTarget",
      "Target.receivedMessageFromTarget",
    ] as const)
      owner.cdp.on(method, (params: unknown) =>
        owner.event("", method, params),
      );
    try {
      await owner.initialize(target);
      return owner;
    } catch (cause: unknown) {
      const cleanup = () => owner.close();
      try {
        return await failBrowserScenarioOperation(cleanup, cause);
      } catch (failure: unknown) {
        if (failure !== cause) retainCleanup?.(cleanup);
        throw failure;
      }
    }
  }

  private target(
    parentId: string | undefined,
    send: StorageTarget["send"],
  ): StorageTarget {
    return {
      parentId,
      send,
      contexts: new Map(),
      scripts: new Map(),
      ready: Promise.resolve(),
      script: undefined,
      breakpoint: undefined,
    };
  }

  private async initialize(target: StorageTarget): Promise<void> {
    await target.send("Page.enable");
    await target.send("Runtime.enable");
    await target.send("Debugger.enable");
    target.breakpoint = stringReply("breakpointId").parse(
      await target.send("Debugger.setBreakpointByUrl", {
        url: this.sourceUrl,
        lineNumber: 1,
      }),
    ).breakpointId;
    target.script = stringReply("identifier").parse(
      await target.send("Page.addScriptToEvaluateOnNewDocument", {
        worldName: this.sourceUrl,
        source: `(() => {\n  void 0;\n})()\n//# sourceURL=${this.sourceUrl}`,
      }),
    ).identifier;
    await target.send("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: false,
    });
  }

  private event(sessionId: string, method: string, params: unknown): void {
    try {
      const target = this.targets.get(sessionId);
      if (target === undefined) return;
      if (method === "Runtime.executionContextCreated") {
        const { context } = contextEvent.parse(params);
        if (context.name === this.sourceUrl)
          target.contexts.set(context.id, context);
      } else if (method === "Runtime.executionContextDestroyed") {
        target.contexts.delete(
          z.object({ executionContextId: z.number() }).parse(params)
            .executionContextId,
        );
      } else if (method === "Runtime.executionContextsCleared") {
        target.contexts.clear();
        target.scripts.clear();
      } else if (method === "Debugger.scriptParsed") {
        const script = scriptEvent.parse(params);
        if (script.url === this.sourceUrl)
          target.scripts.set(script.scriptId, script.executionContextId);
      } else if (method === "Debugger.paused") {
        const pause = pausedEvent.parse(params);
        const work = this.work.then(() => this.seed(target, pause));
        this.work = work.catch((cause: unknown) => this.fail(cause));
      } else if (method === "Target.attachedToTarget")
        this.attach(sessionId, attachedEvent.parse(params));
      else if (method === "Target.detachedFromTarget")
        this.detached(detachedEvent.parse(params).sessionId);
      else if (method === "Target.receivedMessageFromTarget") {
        const { sessionId: childId, message } = messageEvent.parse(params);
        const reply = protocolMessage.parse(JSON.parse(message));
        if (reply.id !== undefined) {
          const waiter = this.replies.get(reply.id);
          this.replies.delete(reply.id);
          if (reply.error !== undefined)
            waiter?.reject(new Error(reply.error.message));
          else waiter?.resolve(reply.result);
        } else if (reply.method !== undefined)
          this.event(childId, reply.method, reply.params);
      }
    } catch (cause: unknown) {
      this.fail(cause);
    }
  }

  private fail(cause: unknown): void {
    this.failure ??= new BrowserObservationError(
      "capture_browser_scenario",
      "protocol_error",
      { cause },
    );
  }

  private async seed(
    target: StorageTarget,
    pause: z.infer<typeof pausedEvent>,
  ): Promise<void> {
    try {
      const frame = pause.callFrames[0];
      const contextId =
        frame === undefined
          ? undefined
          : target.scripts.get(frame.location.scriptId);
      const context =
        contextId === undefined ? undefined : target.contexts.get(contextId);
      const seed =
        context === undefined ? undefined : this.seeds.get(context.origin);
      if (
        this.closed ||
        seed === undefined ||
        frame === undefined ||
        context?.auxData?.frameId === undefined
      )
        return;
      const key = stringReply("storageKey").parse(
        await target.send("Storage.getStorageKeyForFrame", {
          frameId: context.auxData.frameId,
        }),
      ).storageKey;
      if (key === undefined || this.initialized.has(key)) return;
      const payload = JSON.stringify(seed).replaceAll("<", "\\u003c");
      const reply = evaluationReply.parse(
        await target.send("Debugger.evaluateOnCallFrame", {
          callFrameId: frame.callFrameId,
          expression: `(() => { const seed = ${payload}; for (const [name, value] of seed.local) localStorage.setItem(name, value); for (const [name, value] of seed.session) sessionStorage.setItem(name, value); })()`,
          returnByValue: true,
        }),
      );
      if (reply.exceptionDetails !== undefined)
        throw new BrowserObservationError(
          "capture_browser_scenario",
          "protocol_error",
          { detail: "The browser denied initial storage initialization." },
        );
      this.initialized.add(key);
    } finally {
      await target.send("Debugger.resume");
    }
  }

  private attach(parentId: string, event: z.infer<typeof attachedEvent>): void {
    const parent = this.targets.get(parentId);
    if (parent === undefined) return;
    const { sessionId, targetInfo } = event;
    const target = this.target(parentId, async (method, params = {}) => {
      const id = ++this.sequence;
      const reply = new Promise<unknown>((resolve, reject) =>
        this.replies.set(id, { sessionId, resolve, reject }),
      );
      // Await the envelope and its reply together so disconnect cannot orphan a rejection.
      const sent = parent.send("Target.sendMessageToTarget", {
        sessionId,
        message: JSON.stringify({ id, method, params }),
      });
      try {
        const [, result] = await Promise.all([sent, reply]);
        return result;
      } finally {
        this.replies.delete(id);
      }
    });
    this.targets.set(sessionId, target);
    target.ready = (async () => {
      try {
        if (!this.closed && targetInfo.type === "iframe")
          await this.initialize(target);
      } finally {
        await target.send("Runtime.runIfWaitingForDebugger");
      }
    })().catch((cause: unknown) => {
      if (this.targets.has(sessionId)) this.fail(cause);
    });
  }

  private detached(sessionId: string): void {
    for (const [id, target] of this.targets)
      if (target.parentId === sessionId) this.detached(id);
    this.targets.delete(sessionId);
    for (const [id, reply] of this.replies)
      if (reply.sessionId === sessionId) {
        this.replies.delete(id);
        reply.reject(
          new BrowserObservationError(
            "capture_browser_scenario",
            "disconnected",
          ),
        );
      }
  }

  async settle(): Promise<void> {
    await Promise.all([...this.targets.values()].map((target) => target.ready));
    await this.work;
    if (this.failure !== undefined) throw this.failure;
  }

  close(stopLoading = false): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    const closing = this.closeResources(stopLoading).catch((cause: unknown) => {
      throw new BrowserObservationError(
        "capture_browser_scenario",
        "cleanup_failed",
        {
          cause,
          cleanup: {
            reason: cause instanceof Error ? cause.message : String(cause),
            resources: ["browser_transport"],
          },
        },
      );
    });
    this.closePromise = closing;
    void closing.catch(() => {
      if (this.closePromise === closing) this.closePromise = undefined;
    });
    return closing;
  }

  private async closeResources(stopLoading: boolean): Promise<void> {
    this.closed = true;
    try {
      await withPlaywrightExecutionBoundary(async () => {
        // Stop an unfinished navigation before renderer-side script removal.
        // Otherwise cancellation can leave those commands waiting for a response.
        if (stopLoading) await this.targets.get("")?.send("Page.stopLoading");
        await this.work;
        for (const [id, target] of [...this.targets].reverse()) {
          await target.ready;
          if (!this.targets.has(id)) continue;
          if (target.script !== undefined)
            await target.send("Page.removeScriptToEvaluateOnNewDocument", {
              identifier: target.script,
            });
          if (target.breakpoint !== undefined)
            await target.send("Debugger.removeBreakpoint", {
              breakpointId: target.breakpoint,
            });
          await target.send("Debugger.disable");
          await target.send("Target.setAutoAttach", {
            autoAttach: false,
            waitForDebuggerOnStart: false,
            flatten: false,
          });
        }
      }, 1_000);
    } finally {
      try {
        await this.cdp.detach();
      } finally {
        this.removeListeners();
        for (const sessionId of [...this.targets.keys()])
          this.detached(sessionId);
      }
    }
  }
}
