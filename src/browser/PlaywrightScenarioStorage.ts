import { AnalysisCleanupLease } from "../resources/index.js";
import { randomUUID } from "node:crypto";

import { z } from "zod";
import {
  registeredCdpEvent,
  type CdpEventPayload,
  type CdpRegisteredEvent,
} from "./protocol/CdpEvents.js";
import type { BrowserContext, Page } from "playwright-core";

import type { BrowserScenario } from "../domain/browserScenario.js";
import { BrowserObservationError } from "../domain/browserObservationError.js";
import type { BrowserScenarioSecrets } from "./BrowserScenarioSecrets.js";
import { withPlaywrightExecutionBoundary } from "./PlaywrightExecutionBoundary.js";
import {
  admitCdpReply,
  CdpMalformedReply,
  type CdpCommand,
  type CdpCommandParams,
  type CdpCommandResult,
} from "./protocol/CdpCommands.js";
import {
  newPlaywrightCdpSession,
  type PlaywrightCdpSession,
} from "./PlaywrightCdpSession.js";
import {
  releaseLateScenarioCommand,
  scenarioCommandPending,
  scenarioCommandTimeoutMs,
  withScenarioCommandDeadline,
} from "./ScenarioCommandDeadline.js";

type StorageEventMethod =
  | "Runtime.executionContextCreated"
  | "Runtime.executionContextDestroyed"
  | "Runtime.executionContextsCleared"
  | "Debugger.scriptParsed"
  | "Debugger.paused"
  | "Target.attachedToTarget"
  | "Target.detachedFromTarget"
  | "Target.receivedMessageFromTarget";
const STORAGE_EVENT_METHODS = [
  "Runtime.executionContextCreated",
  "Runtime.executionContextDestroyed",
  "Runtime.executionContextsCleared",
  "Debugger.scriptParsed",
  "Debugger.paused",
  "Target.attachedToTarget",
  "Target.detachedFromTarget",
  "Target.receivedMessageFromTarget",
] as const satisfies readonly StorageEventMethod[];
type StorageEvent = Extract<CdpRegisteredEvent, { method: StorageEventMethod }>;
const isStorageEvent = (
  event: CdpRegisteredEvent | undefined,
): event is StorageEvent =>
  event !== undefined &&
  (STORAGE_EVENT_METHODS as readonly string[]).includes(event.method);

/** The nested transport's envelope: a command reply or an event message. */
const nestedProtocolMessage = z.object({
  id: z.number().optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.object({ message: z.string() }).optional(),
});
type PausedCallFrames = Extract<
  CdpEventPayload<"Debugger.paused">,
  { success: true }
>["data"];

/** Private seeding needs every identity member a registered payload may leave unknown. */
const required = <T>(value: T | undefined, method: string): T => {
  if (value === undefined)
    throw new TypeError(`${method} declared a malformed payload.`);
  return value;
};

interface StorageContext {
  readonly id: number;
  readonly origin: string;
  readonly name: string;
  readonly frameId: string | undefined;
}

const storageContext = (
  facts: CdpEventPayload<"Runtime.executionContextCreated">["facts"],
): StorageContext => {
  const method = "Runtime.executionContextCreated";
  // A supplied frame claim must be a string; the empty spelling stays as reported.
  if (
    facts.frameClaim.state === "invalid" &&
    facts.frameClaim.frameId === undefined
  )
    required(undefined, method);
  return {
    id: required(facts.id, method),
    origin: required(facts.origin, method),
    name: required(facts.name, method),
    frameId: facts.frameClaim.frameId,
  };
};
const STORAGE_CLEANUP_TIMEOUT_MS = 1_000;

type StorageSeed = {
  local: [string, string][];
  session: [string, string][];
};

interface StorageTarget {
  readonly parentId: string | undefined;
  readonly topLevelTargetId: string;
  /** Replies of registered commands are admitted by their result schemas. */
  readonly send: <M extends CdpCommand>(
    method: M,
    params?: CdpCommandParams<M>,
    timeoutMs?: number,
  ) => Promise<CdpCommandResult<M>>;
  readonly contexts: Map<number, StorageContext>;
  readonly scripts: Map<string, number>;
  ready: Promise<void>;
  waitingForDebugger: boolean;
}

type PendingReply = {
  readonly sessionId: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
};
type StorageInstallationOptions = {
  readonly signal?: AbortSignal;
  readonly retainCleanup?: (lease: AnalysisCleanupLease) => void;
};
type StoragePage = { readonly context: BrowserContext; readonly page: Page };
export type PlaywrightScenarioStorageCleanup = {
  readonly loadingStopped: boolean;
};

/** Owns pre-script storage seeding and its CDP instrumentation for one scenario. */
export class PlaywrightScenarioStorage {
  readonly #seeds = new Map<string, StorageSeed>();
  readonly #initializedLocal = new Set<string>();
  readonly #initializedSession = new Set<string>();
  readonly #targets = new Map<string, StorageTarget>();
  readonly #replies = new Map<number, PendingReply>();
  readonly #sourceUrl = `rea-storage-${randomUUID()}`;
  readonly #unsubscribers: (() => void)[] = [];
  #sequence = 0;
  #generation = 0;
  #closed = false;
  #cleanupCompleted = false;
  #loadingStopped = false;
  #popupSeedCoverageUnknown = false;
  #failure: BrowserObservationError | undefined;
  #closePromise: Promise<PlaywrightScenarioStorageCleanup> | undefined;
  #detachPromise: Promise<void> | undefined;
  #rootInitialization: Promise<void> | undefined;
  #work: Promise<void> = Promise.resolve();
  #removeListeners: () => void = () => undefined;

  private constructor(
    private readonly cdp: PlaywrightCdpSession,
    private readonly signal: AbortSignal | undefined,
    private readonly commandTimeoutMs: number,
    private readonly ownsContext: boolean,
  ) {}

  static async create(
    storagePage: StoragePage,
    scenario: BrowserScenario,
    secrets: BrowserScenarioSecrets,
    options: StorageInstallationOptions = {},
  ): Promise<PlaywrightScenarioStorage | undefined> {
    const { signal, retainCleanup } = options;
    const { context, page } = storagePage;
    if (
      scenario.storage.local_storage.length === 0 &&
      scenario.storage.session_storage.length === 0
    )
      return undefined;

    const commandTimeoutMs = scenarioCommandTimeoutMs(scenario);
    const connection = newPlaywrightCdpSession(
      context,
      page,
      "capture_browser_scenario",
    );
    let cdp: PlaywrightCdpSession;
    try {
      cdp = await withPlaywrightExecutionBoundary(
        () =>
          withScenarioCommandDeadline(
            () => connection,
            commandTimeoutMs,
            "command",
            "Target.attachToTarget",
          ),
        undefined,
        signal,
      );
    } catch (cause: unknown) {
      if (signal?.aborted === true) {
        let detached = false;
        const lateCleanup = async (): Promise<void> => {
          let session: PlaywrightCdpSession;
          try {
            session = await connection;
          } catch {
            return;
          }
          if (!detached) {
            await session.detach();
            detached = true;
          }
        };
        const cleanup = new AnalysisCleanupLease(lateCleanup, [
          "browser_storage_transport",
        ]);
        retainCleanup?.(cleanup);
        void withPlaywrightExecutionBoundary(
          () => cleanup.release(),
          STORAGE_CLEANUP_TIMEOUT_MS,
        ).catch(() => undefined);
      } else if (scenarioCommandPending(cause) !== undefined) {
        const cleanup = new AnalysisCleanupLease(
          () => releaseLateScenarioCommand(cause),
          ["browser_storage_transport"],
        );
        retainCleanup?.(cleanup);
        void withPlaywrightExecutionBoundary(
          () => cleanup.release(),
          STORAGE_CLEANUP_TIMEOUT_MS,
        ).catch(() => undefined);
      }
      throw cause;
    }
    const owner = new PlaywrightScenarioStorage(
      cdp,
      signal,
      commandTimeoutMs,
      scenario.browser.mode === "launch",
    );
    owner.addSeeds(scenario.storage.local_storage, "local", secrets);
    owner.addSeeds(scenario.storage.session_storage, "session", secrets);
    return owner;
  }

  async initialize(page: Page, context: BrowserContext): Promise<void> {
    const initialization = this.initializeRoot(page, context);
    this.#rootInitialization = initialization;
    await withPlaywrightExecutionBoundary(
      () => initialization,
      undefined,
      this.signal,
    );
  }

  private async initializeRoot(
    page: Page,
    context: BrowserContext,
  ): Promise<void> {
    const rootInfo = await withScenarioCommandDeadline(
      () => this.cdp.send("Target.getTargetInfo"),
      this.commandTimeoutMs,
      "command",
      "Target.getTargetInfo",
    );
    if (this.#closed) return;
    const root = this.createTarget(
      undefined,
      rootInfo.targetInfo.targetId,
      (method, params, timeoutMs = this.commandTimeoutMs) =>
        withScenarioCommandDeadline(
          () => this.cdp.send(method, params),
          timeoutMs,
          "command",
          method,
        ),
    );
    this.#targets.set("", root);
    this.listen(page, context);
    const ready = this.initializeTarget(root);
    root.ready = ready;
    await ready;
  }

  private addSeeds(
    blocks: BrowserScenario["storage"]["local_storage"],
    kind: "local" | "session",
    secrets: BrowserScenarioSecrets,
  ): void {
    for (const { origin, entries } of blocks) {
      const seed = this.#seeds.get(origin) ?? { local: [], session: [] };
      seed[kind].push(
        ...entries.map(({ name, value }): [string, string] => [
          name,
          secrets.value(value),
        ]),
      );
      this.#seeds.set(origin, seed);
    }
  }

  private listen(page: Page, context: BrowserContext): void {
    const browser = context.browser();
    const detached = (): void => this.targetDetached("");
    page.on("close", detached);
    context.on("close", detached);
    browser?.on("disconnected", detached);
    // Discovery is later than the first popup script. It cannot establish
    // that root-session instrumentation controlled this top-level context.
    const popup = (opened: Page): void => {
      if (opened !== page) this.#popupSeedCoverageUnknown = true;
    };
    if (this.ownsContext) context.on("page", popup);
    else page.on("popup", popup);
    this.#removeListeners = () => {
      page.off("close", detached);
      context.off("close", detached);
      browser?.off("disconnected", detached);
      if (this.ownsContext) context.off("page", popup);
      else page.off("popup", popup);
    };
    for (const method of STORAGE_EVENT_METHODS)
      this.#unsubscribers.push(
        this.cdp.on(method, (event) => this.event("", event)),
      );
  }

  limitations(): readonly string[] {
    return this.#popupSeedCoverageUnknown
      ? [
          "Declared non-cookie storage seeds were controlled for the selected page's instrumented frames; initialization before the first script is unknown for discovered popup top-level contexts.",
        ]
      : [];
  }

  private createTarget(
    parentId: string | undefined,
    topLevelTargetId: string,
    send: StorageTarget["send"],
  ): StorageTarget {
    return {
      parentId,
      topLevelTargetId,
      send,
      contexts: new Map(),
      scripts: new Map(),
      ready: Promise.resolve(),
      waitingForDebugger: false,
    };
  }

  private async initializeTarget(target: StorageTarget): Promise<void> {
    if (this.#closed) return;
    await target.send("Page.enable");
    if (this.#closed) return;
    await target.send("Runtime.enable");
    if (this.#closed) return;
    await target.send("Debugger.enable");
    if (this.#closed) return;
    await target.send("Debugger.setBreakpointByUrl", {
      url: this.#sourceUrl,
      lineNumber: 1,
    });
    if (this.#closed) return;
    await target.send("Page.addScriptToEvaluateOnNewDocument", {
      worldName: this.#sourceUrl,
      source: `(() => {\n  void 0;\n})()\n//# sourceURL=${this.#sourceUrl}`,
    });
    if (this.#closed) return;
    await target.send("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: false,
    });
  }

  private sendObserved<M extends CdpCommand>(
    target: StorageTarget,
    method: M,
    params?: CdpCommandParams<M>,
  ): Promise<CdpCommandResult<M>> {
    return withPlaywrightExecutionBoundary(
      () => target.send(method, params),
      undefined,
      this.signal,
    );
  }

  private event(sessionId: string, event: StorageEvent): void {
    if (this.#closed) return;
    const target = this.#targets.get(sessionId);
    if (target === undefined) return;
    try {
      switch (event.method) {
        case "Runtime.executionContextCreated": {
          const context = storageContext(event.payload.facts);
          if (context.name === this.#sourceUrl)
            target.contexts.set(context.id, context);
          break;
        }
        case "Runtime.executionContextDestroyed":
          target.contexts.delete(required(event.payload.id, event.method));
          break;
        case "Runtime.executionContextsCleared":
          target.contexts.clear();
          target.scripts.clear();
          break;
        case "Debugger.scriptParsed": {
          const { facts } = event.payload;
          const scriptId = required(facts.scriptId, event.method);
          const url = required(facts.url, event.method);
          const contextId = required(facts.contextId, event.method);
          if (url === this.#sourceUrl) target.scripts.set(scriptId, contextId);
          break;
        }
        case "Debugger.paused": {
          if (!event.payload.success) throw event.payload.error;
          const pause = event.payload.data;
          const frame = pause.callFrames[0];
          // CDP resume is target-wide, so identify our private seed frame before
          // doing any work that will resume the paused target.
          if (
            frame === undefined ||
            !target.scripts.has(frame.location.scriptId)
          )
            return;
          this.#generation += 1;
          this.#work = this.#work
            .then(() => this.seed(target, pause))
            .catch((cause: unknown) => {
              if (sessionId === "" || this.#targets.get(sessionId) === target)
                this.fail(cause);
            });
          break;
        }
        case "Target.attachedToTarget":
          this.#generation += 1;
          this.attach(sessionId, {
            sessionId: required(event.payload.sessionId, event.method),
            targetId: required(event.payload.targetId, event.method),
            targetType: required(event.payload.targetType, event.method),
          });
          break;
        case "Target.detachedFromTarget":
          this.#generation += 1;
          this.targetDetached(required(event.payload.sessionId, event.method));
          break;
        case "Target.receivedMessageFromTarget":
          this.nestedMessage(
            required(event.payload.sessionId, event.method),
            required(event.payload.message, event.method),
          );
          break;
      }
    } catch (cause: unknown) {
      this.fail(cause);
    }
  }

  private nestedMessage(sessionId: string, message: string): void {
    const reply = nestedProtocolMessage.parse(JSON.parse(message));
    if (reply.id !== undefined) {
      const waiter = this.#replies.get(reply.id);
      if (waiter?.sessionId !== sessionId) return;
      this.#replies.delete(reply.id);
      if (reply.error !== undefined)
        waiter.reject(new Error(reply.error.message));
      else waiter.resolve(reply.result);
      return;
    }
    if (reply.method === undefined) return;
    // A child session's events are admitted by the same registered schemas.
    const registered = registeredCdpEvent(reply.method, reply.params);
    if (isStorageEvent(registered)) this.event(sessionId, registered);
  }

  private fail(cause: unknown): void {
    this.#generation += 1;
    // A child command deadline is already the caller-facing failure. Storing
    // it keeps the command name, selected deadline, and recovery advice.
    this.#failure ??=
      cause instanceof CdpMalformedReply ||
      (cause instanceof BrowserObservationError && cause.reason === "timeout")
        ? cause
        : new BrowserObservationError(
            "capture_browser_scenario",
            "protocol_error",
            { cause },
          );
  }

  private async seedPausedFrame(
    target: StorageTarget,
    frame: PausedCallFrames["callFrames"][number],
  ): Promise<void> {
    const contextId = target.scripts.get(frame.location.scriptId);
    const context =
      contextId === undefined ? undefined : target.contexts.get(contextId);
    if (this.#closed) return;
    const frameId = context?.frameId;
    if (context === undefined || frameId === undefined)
      throw new Error(
        "The private storage seed frame has no execution context or frame identity.",
      );
    // Some Chrome builds leave an isolated world's origin empty. The frame's
    // security origin is authoritative; neither its URL nor its opaque storage
    // key establishes the document principal (for example, inherited origins).
    const origin =
      context.origin === ""
        ? await this.frameOrigin(target, frameId)
        : context.origin;
    const seed = this.#seeds.get(origin);
    if (seed === undefined) return;

    const { storageKey } = await this.sendObserved(
      target,
      "Storage.getStorageKey",
      { frameId },
    );
    const sessionKey = JSON.stringify([target.topLevelTargetId, storageKey]);
    const local =
      this.#initializedLocal.has(storageKey) || seed.local.length === 0
        ? []
        : seed.local;
    const session =
      this.#initializedSession.has(sessionKey) || seed.session.length === 0
        ? []
        : seed.session;
    if (local.length === 0 && session.length === 0) return;

    const payload = JSON.stringify({ local, session }).replaceAll(
      "<",
      "\\u003c",
    );
    const response = await this.sendObserved(
      target,
      "Debugger.evaluateOnCallFrame",
      {
        callFrameId: frame.callFrameId,
        expression: `(() => { const seed = ${payload}; for (const [name, value] of seed.local) localStorage.setItem(name, value); for (const [name, value] of seed.session) sessionStorage.setItem(name, value); })()`,
        returnByValue: true,
      },
    );
    if (response.exceptionDetails !== undefined)
      throw new BrowserObservationError(
        "capture_browser_scenario",
        "protocol_error",
        { detail: "The browser denied initial storage initialization." },
      );
    if (local.length > 0) this.#initializedLocal.add(storageKey);
    if (session.length > 0) this.#initializedSession.add(sessionKey);
  }

  private async frameOrigin(
    target: StorageTarget,
    frameId: string,
  ): Promise<string> {
    const tree = await this.sendObserved(target, "Page.getFrameTree");
    const origin = tree.frames.find(
      (frame) => frame.facts.frameId === frameId,
    )?.securityOrigin;
    if (origin !== undefined && origin !== "") return origin;
    throw new Error(
      "The browser did not establish the private storage seed frame's security origin.",
    );
  }

  private async seed(
    target: StorageTarget,
    pause: PausedCallFrames,
  ): Promise<void> {
    const frame = pause.callFrames[0];
    if (frame === undefined) return;

    let primaryFailure: unknown;
    let hasPrimaryFailure = false;
    try {
      await this.seedPausedFrame(target, frame);
    } catch (cause: unknown) {
      primaryFailure = cause;
      hasPrimaryFailure = true;
    }
    let resumeFailure: unknown;
    try {
      await withPlaywrightExecutionBoundary(
        () =>
          target.send("Debugger.resume", undefined, STORAGE_CLEANUP_TIMEOUT_MS),
        STORAGE_CLEANUP_TIMEOUT_MS,
      );
    } catch (cause: unknown) {
      resumeFailure = cause;
    }
    if (hasPrimaryFailure && resumeFailure !== undefined)
      throw new AggregateError(
        [primaryFailure, resumeFailure],
        "Storage initialization and debugger resume both failed",
        { cause: primaryFailure },
      );
    if (this.signal?.aborted === true && resumeFailure === undefined) return;
    if (hasPrimaryFailure) throw primaryFailure;
    if (resumeFailure !== undefined) throw resumeFailure;
  }

  private attach(
    parentId: string,
    event: {
      readonly sessionId: string;
      readonly targetId: string;
      readonly targetType: string;
    },
  ): void {
    const parent = this.#targets.get(parentId);
    if (parent === undefined) return;
    const { sessionId, targetType } = event;
    const target = this.createTarget(
      parentId,
      targetType === "iframe" ? parent.topLevelTargetId : event.targetId,
      async (method, params, timeoutMs = this.commandTimeoutMs) => {
        const id = ++this.#sequence;
        let rejectReply: ((error: Error) => void) | undefined;
        const reply = new Promise<unknown>((resolve, reject) => {
          rejectReply = reject;
          this.#replies.set(id, { sessionId, resolve, reject });
        });
        try {
          const sent = parent.send(
            "Target.sendMessageToTarget",
            {
              sessionId,
              message: JSON.stringify({ id, method, params: params ?? {} }),
            },
            timeoutMs,
          );
          // Delivery through the root session and the nested reply share one deadline.
          const [, result] = await withScenarioCommandDeadline(
            () => Promise.all([sent, reply]),
            timeoutMs,
            "command",
            method,
          );
          return admitCdpReply(method, result, "capture_browser_scenario");
        } catch (cause: unknown) {
          rejectReply?.(
            cause instanceof Error
              ? cause
              : new BrowserObservationError(
                  "capture_browser_scenario",
                  "protocol_error",
                  { cause },
                ),
          );
          throw cause;
        } finally {
          this.#replies.delete(id);
        }
      },
    );
    target.waitingForDebugger = true;
    this.#targets.set(sessionId, target);
    target.ready = (async () => {
      try {
        if (!this.#closed && (targetType === "iframe" || targetType === "page"))
          await this.initializeTarget(target);
      } catch (cause: unknown) {
        if (
          this.signal?.aborted !== true &&
          !this.#closed &&
          this.#targets.get(sessionId) === target
        )
          this.fail(cause);
      }
      if (this.#targets.get(sessionId) !== target) return;
      try {
        await withPlaywrightExecutionBoundary(
          () =>
            target.send(
              "Runtime.runIfWaitingForDebugger",
              undefined,
              STORAGE_CLEANUP_TIMEOUT_MS,
            ),
          STORAGE_CLEANUP_TIMEOUT_MS,
        );
        target.waitingForDebugger = false;
      } catch (cause: unknown) {
        if (
          this.signal?.aborted !== true &&
          !this.#closed &&
          this.#targets.get(sessionId) === target
        )
          this.fail(cause);
      }
    })();
  }

  private targetDetached(sessionId: string): void {
    for (const [id, target] of this.#targets)
      if (target.parentId === sessionId) this.targetDetached(id);
    this.#targets.delete(sessionId);
    for (const [id, reply] of this.#replies)
      if (reply.sessionId === sessionId) {
        this.#replies.delete(id);
        reply.reject(
          new BrowserObservationError(
            "capture_browser_scenario",
            "disconnected",
          ),
        );
      }
    this.#generation += 1;
  }

  async settle(): Promise<void> {
    for (;;) {
      const generation = this.#generation;
      const work = this.#work;
      const targets = [...this.#targets.entries()];
      await withPlaywrightExecutionBoundary(
        () => Promise.all(targets.map(([, target]) => target.ready)),
        undefined,
        this.signal,
      );
      await withPlaywrightExecutionBoundary(() => work, undefined, this.signal);
      await Promise.resolve();
      if (this.#failure !== undefined) throw this.#failure;
      if (
        generation === this.#generation &&
        work === this.#work &&
        targets.every(([id, target]) => this.#targets.get(id) === target)
      )
        return;
    }
  }

  close(stopLoading = false): Promise<PlaywrightScenarioStorageCleanup> {
    if (this.#cleanupCompleted)
      return Promise.resolve({ loadingStopped: this.#loadingStopped });
    if (this.#closePromise !== undefined) return this.#closePromise;
    const closing = this.closeResources(stopLoading).catch((cause: unknown) => {
      throw new BrowserObservationError(
        "capture_browser_scenario",
        "cleanup_failed",
        {
          cause,
          cleanup: {
            reason: cause instanceof Error ? cause.message : String(cause),
            resources: ["browser_transport", "browser_storage_bootstrap"],
          },
        },
      );
    });
    this.#closePromise = closing;
    void closing.catch(() => {
      if (this.#closePromise === closing) this.#closePromise = undefined;
    });
    return closing;
  }

  private async closeResources(
    stopLoading: boolean,
  ): Promise<PlaywrightScenarioStorageCleanup> {
    this.#closed = true;
    let stopLoadingFailure: { readonly cause: unknown } | undefined;
    if (stopLoading && !this.#loadingStopped) {
      try {
        const root = this.#targets.get("");
        if (root !== undefined) {
          await withPlaywrightExecutionBoundary(
            () => this.cdp.send("Page.stopLoading"),
            STORAGE_CLEANUP_TIMEOUT_MS,
          );
          this.#loadingStopped = true;
        }
      } catch (cause: unknown) {
        stopLoadingFailure = { cause };
      }
    }

    const work = this.#work;
    const rootInitialization = this.#rootInitialization;
    const targets = [...this.#targets.values()];
    try {
      await withPlaywrightExecutionBoundary(
        () =>
          Promise.all([
            work.catch(() => undefined),
            ...(rootInitialization === undefined
              ? []
              : [rootInitialization.catch(() => undefined)]),
            ...targets.map((target) => target.ready.catch(() => undefined)),
          ]),
        STORAGE_CLEANUP_TIMEOUT_MS,
      );
    } catch {
      // Detaching the owning CDP session below is the terminal release for
      // scripts, breakpoints, debugger state, and attached child sessions.
    }

    let detach = this.#detachPromise;
    if (detach === undefined) {
      detach = Promise.resolve().then(() => this.cdp.detach());
      this.#detachPromise = detach;
      void detach.catch(() => {
        if (this.#detachPromise === detach) this.#detachPromise = undefined;
      });
    }
    await withPlaywrightExecutionBoundary(
      () => detach,
      STORAGE_CLEANUP_TIMEOUT_MS,
    );

    for (const unsubscribe of this.#unsubscribers.splice(0)) unsubscribe();
    this.#removeListeners();
    for (const reply of this.#replies.values())
      reply.reject(
        new BrowserObservationError("capture_browser_scenario", "disconnected"),
      );
    this.#targets.clear();
    this.#replies.clear();
    this.#cleanupCompleted = true;
    if (stopLoadingFailure !== undefined) throw stopLoadingFailure.cause;
    return { loadingStopped: this.#loadingStopped };
  }
}
