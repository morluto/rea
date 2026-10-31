import { PrivateRuntimeRoot } from "./PrivateRuntimeRoot.js";
import type { Readable, Writable } from "node:stream";
import {
  ProviderProcessSupervisor,
  spawnOwnedProviderProcess,
  type OwnedProviderProcessSpawnOptions,
  type ProviderProcessSupervisorOptions,
  type ProviderProcessStopResult,
} from "./ProviderProcess.js";
import { cleanupOwnedProcessGroup } from "./ProcessOwnership.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";

export interface OwnedWorkerRuntimeOptions {
  readonly rootPrefix: string;
  readonly launcher?: typeof spawnOwnedProviderProcess;
  readonly supervisorOptions?: ProviderProcessSupervisorOptions;
  /** Report request-stream failure at the lifecycle owner observation point. */
  readonly onInputFailure?: (cause: Error) => void;
  /** Let a higher-level owner release its dependent resources before this root. */
  readonly retryCleanup?: () => Promise<void>;
}

export class OwnedWorkerRuntimeCleanupError extends Error {
  readonly #cleanupEpoch: OwnedWorkerRuntimeCleanupEpoch | undefined;

  constructor(
    readonly cleanupResources: readonly string[],
    readonly processId: number | null,
    message: string,
    cleanupEpoch: OwnedWorkerRuntimeCleanupEpoch | undefined,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "OwnedWorkerRuntimeCleanupError";
    this.#cleanupEpoch = cleanupEpoch;
  }

  bindCleanupFailure(error: OwnedWorkerCleanupFailure | AnalysisError): void {
    if (this.#cleanupEpoch === undefined) {
      error.bindCleanupResourceOwner(releasedCleanupOwner);
      error.resolveCleanup();
      return;
    }
    this.#cleanupEpoch.bind(error);
  }
}

export interface OwnedWorkerCleanupFailure {
  bindCleanupResourceOwner(owner: {
    readonly cleanupResources: readonly string[] | undefined;
  }): unknown;
  resolveCleanup(): unknown;
}

/** A root's cleanup attribution is stable even after this runtime is reused. */
class OwnedWorkerRuntimeCleanupEpoch {
  #released = false;
  #runId: string | undefined;
  #failures: WeakRef<OwnedWorkerCleanupFailure>[] = [];

  constructor(readonly rootPath: string) {}

  get cleanupResources(): readonly string[] {
    return this.#released
      ? []
      : [...(this.#runId === undefined ? [] : [this.#runId]), this.rootPath];
  }

  setRunId(runId: string | undefined): void {
    if (!this.#released) this.#runId = runId;
  }

  bind(error: OwnedWorkerCleanupFailure | AnalysisError): void {
    error.bindCleanupResourceOwner(this);
    if (this.#released) {
      error.resolveCleanup();
      return;
    }
    this.#failures = [
      ...this.#failures.filter((reference) => reference.deref() !== undefined),
      new WeakRef(error),
    ];
  }

  release(): void {
    if (this.#released) return;
    this.#released = true;
    for (const reference of this.#failures) reference.deref()?.resolveCleanup();
    this.#failures = [];
  }
}

/** Own the private root and process lifecycle shared by sequential workers. */
export class OwnedWorkerRuntime {
  static readonly #pending = new Set<OwnedWorkerRuntime>();

  #root: PrivateRuntimeRoot | undefined;
  #cleanupEpoch: OwnedWorkerRuntimeCleanupEpoch | undefined;
  #supervisor: ProviderProcessSupervisor | undefined;
  #acquisition: Promise<void> | undefined;
  #cleanupRetryAttempt: Promise<void> | undefined;
  #stopAttempt: Promise<ProviderProcessStopResult> | undefined;
  #closeAttempt: Promise<void> | undefined;
  #closing = false;
  #closed = false;
  #lastRunId: string | undefined;
  #terminalCloseRequested = false;
  #inputFailure: Error | undefined;
  #stdinGeneration = 0;
  readonly #stdoutListeners = new Set<{
    readonly stream: Readable;
    readonly listener: (chunk: Buffer | string) => void;
  }>();

  constructor(readonly options: OwnedWorkerRuntimeOptions) {}

  get rootPath(): string | undefined {
    return this.#root?.path;
  }

  /** Exposes the exact supervisor so consumers retain their protocol policy. */
  get supervisor(): ProviderProcessSupervisor | undefined {
    return this.#supervisor;
  }

  get cleanupResources(): readonly string[] | undefined {
    const resources = [
      ...(this.#supervisor === undefined
        ? []
        : [this.#supervisor.launch.ownership?.runId ?? this.#lastRunId]),
      ...(this.#root === undefined ? [] : [this.#root.path]),
    ].filter((resource): resource is string => resource !== undefined);
    return resources.length === 0 ? [] : resources;
  }

  /** Whether this exact owner still retains an unconfirmed resource release. */
  get hasPendingCleanup(): boolean {
    return OwnedWorkerRuntime.#pending.has(this);
  }

  /** First error observed on the current child's request stream, if any. */
  get inputFailure(): Error | undefined {
    return this.#inputFailure;
  }

  /** Keep a returned typed cleanup error live until this exact owner releases. */
  bindCleanupFailure(error: OwnedWorkerCleanupFailure | AnalysisError): void {
    if (this.#cleanupEpoch === undefined) {
      error.bindCleanupResourceOwner(releasedCleanupOwner);
      error.resolveCleanup();
      return;
    }
    this.#cleanupEpoch.bind(error);
  }

  /** Mark this still-owned runtime for retry before any consumer starts a child. */
  retainForCleanup(): void {
    OwnedWorkerRuntime.#pending.add(this);
  }

  /** Retry every earlier worker owner before any consumer admits a new child. */
  static async retryPending(except?: OwnedWorkerRuntime): Promise<void> {
    for (const owner of [...this.#pending])
      if (owner !== except) await owner.#retryPending();
  }

  /**
   * Acquire one child and let the protocol owner complete its own handshake.
   * Close waits for this entire callback, including a late handshake.
   */
  start(
    spawnOptions: Omit<OwnedProviderProcessSpawnOptions, "cwd">,
    initialize?: (supervisor: ProviderProcessSupervisor) => Promise<void>,
  ): Promise<void> {
    if (this.#terminalCloseRequested || this.#closing)
      return Promise.reject(new Error("Owned worker runtime is closing"));
    if (this.#acquisition !== undefined) return this.#acquisition;
    if (
      this.#supervisor !== undefined &&
      !OwnedWorkerRuntime.#pending.has(this)
    )
      return Promise.resolve();
    if (
      this.options.retryCleanup !== undefined &&
      OwnedWorkerRuntime.#pending.has(this)
    )
      return this.#retryOwnedCleanup().then(() => {
        if (this.#terminalCloseRequested || this.#closing)
          throw new Error("Owned worker runtime is closing");
        return this.start(spawnOptions, initialize);
      });
    const ownRetry = OwnedWorkerRuntime.#pending.has(this)
      ? this.#retryPending()
      : Promise.resolve();
    const acquisition = ownRetry.then(async () => {
      if (this.#closed) this.#closed = false;
      await this.#start(spawnOptions, initialize);
    });
    this.#acquisition = acquisition;
    void acquisition
      .finally(() => {
        if (this.#acquisition === acquisition) this.#acquisition = undefined;
      })
      .catch(() => undefined);
    return acquisition;
  }

  /** Attach protocol stdout while ensuring it is detached before process stop. */
  onStdout(listener: (chunk: Buffer | string) => void): void {
    const stream = this.#supervisor?.launch.process.stdout;
    if (stream === null || stream === undefined)
      throw new Error("Owned worker runtime has no stdout stream");
    stream.on("data", listener);
    this.#stdoutListeners.add({ stream, listener });
  }

  stop(): Promise<ProviderProcessStopResult> {
    if (this.#stopAttempt !== undefined) return this.#stopAttempt;
    const attempt = this.#stop();
    this.#stopAttempt = attempt;
    void attempt
      .finally(() => {
        if (this.#stopAttempt === attempt) this.#stopAttempt = undefined;
      })
      .catch(() => undefined);
    return attempt;
  }

  /** Stop the exact child before releasing its root; every failure is retryable. */
  close(): Promise<void> {
    this.#terminalCloseRequested = true;
    this.#closing = true;
    if (this.#closed) return Promise.resolve();
    if (this.#closeAttempt !== undefined) return this.#closeAttempt;
    const attempt = this.#close();
    this.#closeAttempt = attempt;
    void attempt
      .finally(() => {
        if (this.#closeAttempt === attempt) this.#closeAttempt = undefined;
      })
      .catch(() => undefined);
    return attempt;
  }

  async #retryPending(): Promise<void> {
    if (this.options.retryCleanup !== undefined)
      return this.#retryOwnedCleanup();
    if (this.#terminalCloseRequested) return this.close();
    this.#closing = true;
    if (this.#closeAttempt === undefined) {
      const attempt = this.#close();
      this.#closeAttempt = attempt;
      void attempt
        .finally(() => {
          if (this.#closeAttempt === attempt) this.#closeAttempt = undefined;
        })
        .catch(() => undefined);
    }
    const attempt = this.#closeAttempt;
    if (attempt === undefined) return;
    try {
      await attempt;
      if (!this.#terminalCloseRequested) {
        this.#closed = false;
        this.#closing = false;
      }
    } catch (cause: unknown) {
      if (!this.#terminalCloseRequested) this.#closing = false;
      throw cause;
    }
  }

  #retryOwnedCleanup(): Promise<void> {
    if (this.#cleanupRetryAttempt !== undefined)
      return this.#cleanupRetryAttempt;
    const attempt = Promise.resolve()
      .then(() => this.options.retryCleanup?.())
      .then(() => {
        if (OwnedWorkerRuntime.#pending.has(this))
          throw this.#cleanupError(
            "Higher-level cleanup retry returned while ownership remains pending",
          );
      });
    this.#cleanupRetryAttempt = attempt;
    void attempt
      .finally(() => {
        if (this.#cleanupRetryAttempt === attempt)
          this.#cleanupRetryAttempt = undefined;
      })
      .catch(() => undefined);
    return attempt;
  }

  async #start(
    spawnOptions: Omit<OwnedProviderProcessSpawnOptions, "cwd">,
    initialize:
      | ((supervisor: ProviderProcessSupervisor) => Promise<void>)
      | undefined,
  ): Promise<void> {
    await OwnedWorkerRuntime.retryPending(this);
    if (this.#closing) throw new Error("Owned worker runtime is closing");
    this.#root ??= await PrivateRuntimeRoot.create({
      prefix: this.options.rootPrefix,
    });
    this.#cleanupEpoch ??= new OwnedWorkerRuntimeCleanupEpoch(this.#root.path);
    if (this.#closing) throw new Error("Owned worker runtime is closing");
    this.#lastRunId = spawnOptions.runId;
    const spawned = await (this.options.launcher ?? spawnOwnedProviderProcess)({
      ...spawnOptions,
      cwd: this.#root.path,
    });
    this.#inputFailure = undefined;
    this.#observeStdin(spawned.process.stdin);
    this.#cleanupEpoch.setRunId(spawned.ownership?.runId ?? spawnOptions.runId);
    this.#supervisor = new ProviderProcessSupervisor(
      {
        ...spawned,
        ownsProcessLifetime: true,
        cleanup:
          spawned.cleanup ??
          (() => cleanupOwnedProcessGroup(spawned.ownership)),
      },
      this.options.supervisorOptions,
    );
    // A close may have begun while spawn was pending. Adopt the process first;
    // close waits for this acquisition and then stops the exact adopted owner.
    if (this.#closing) throw new Error("Owned worker runtime is closing");
    await initialize?.(this.#supervisor);
    if (this.#closing) throw new Error("Owned worker runtime is closing");
  }

  async #stop(): Promise<ProviderProcessStopResult> {
    const acquisition = this.#acquisition;
    if (acquisition !== undefined) await acquisition.catch(() => undefined);
    const supervisor = this.#supervisor;
    if (supervisor === undefined) return { status: "already-exited" };
    this.#detachStdout();
    const stopped = await supervisor.stop();
    if (stopped.status === "incomplete") {
      OwnedWorkerRuntime.#pending.add(this);
      const stdin = supervisor.launch.process.stdin;
      if (
        stdin !== undefined &&
        stdin !== null &&
        !stdin.destroyed &&
        !stdin.writableEnded
      ) {
        try {
          stdin.end();
        } catch {
          // Closing stdin is cooperative only; retain the original stop failure.
        }
      }
      return stopped;
    }
    supervisor.dispose();
    this.#supervisor = undefined;
    this.#cleanupEpoch?.setRunId(undefined);
    return stopped;
  }

  async #close(): Promise<void> {
    const acquisition = this.#acquisition;
    if (acquisition !== undefined) await acquisition.catch(() => undefined);
    const stopped = await this.stop();
    if (stopped.status === "incomplete")
      throw this.#cleanupError(stopped.reason);
    if (this.#root !== undefined) {
      try {
        await this.#root.close();
        this.#root = undefined;
        this.#cleanupEpoch?.release();
        this.#cleanupEpoch = undefined;
      } catch (cause: unknown) {
        OwnedWorkerRuntime.#pending.add(this);
        throw this.#cleanupError(message(cause), cause);
      }
    }
    this.#closed = true;
    OwnedWorkerRuntime.#pending.delete(this);
  }

  #detachStdout(): void {
    for (const { stream, listener } of this.#stdoutListeners)
      stream.off("data", listener);
    this.#stdoutListeners.clear();
  }

  #observeStdin(stream: Writable | null | undefined): void {
    if (stream === null || stream === undefined) return;
    const generation = ++this.#stdinGeneration;
    const onError = (cause: unknown): void => {
      if (
        generation !== this.#stdinGeneration ||
        this.#inputFailure !== undefined
      )
        return;
      this.#inputFailure =
        cause instanceof Error
          ? cause
          : new Error("Owned worker request stream failed", { cause });
      this.options.onInputFailure?.(this.#inputFailure);
    };
    const onClose = (): void => {
      stream.off("error", onError);
      stream.off("close", onClose);
    };
    stream.on("error", onError);
    stream.once("close", onClose);
  }

  #cleanupError(
    reason: string,
    cause?: unknown,
  ): OwnedWorkerRuntimeCleanupError {
    const resources = this.cleanupResources ?? [];
    return new OwnedWorkerRuntimeCleanupError(
      resources,
      this.#supervisor?.launch.process.pid ?? null,
      reason,
      this.#cleanupEpoch,
      cause === undefined ? undefined : { cause },
    );
  }
}

const releasedCleanupOwner = { cleanupResources: [] } as const;

const message = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);
