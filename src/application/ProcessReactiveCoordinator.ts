import {
  commitProcessReactiveProposal,
  createProcessReactiveSnapshot,
  reduceProcessReactiveScenario,
  type ProcessReactiveDecision,
  type ProcessReactiveEffectResult,
  type ProcessReactiveInput,
  type ProcessReactiveSnapshot,
} from "../domain/processReactiveRuntime.js";
import type {
  ProcessReactiveAction,
  ProcessReactiveScenario,
} from "../domain/processReactiveScenario.js";

/** Effect boundary owned by the serialized reactive coordinator. */
export interface ProcessReactiveExecutor {
  execute(
    actions: readonly ProcessReactiveAction[],
    signal: AbortSignal,
  ): Promise<readonly ProcessReactiveEffectResult[]>;
}

/** Cancel handle for one coordinator-owned deadline. */
export interface ProcessReactiveTimer {
  cancel(): void;
}

/** Injectable deadline scheduler used by deterministic coordinator tests. */
export interface ProcessReactiveTimerHost {
  readonly schedule: (
    callback: () => void,
    delayMs: number,
  ) => ProcessReactiveTimer;
}

const systemTimerHost: ProcessReactiveTimerHost = {
  schedule: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    return { cancel: () => clearTimeout(timer) };
  },
};

/**
 * Serializes live observations, deadlines, and effect commits for one run.
 * Producer callbacks enqueue work without awaiting it, preventing reentrancy.
 */
export class ProcessReactiveCoordinator {
  readonly #scenario: ProcessReactiveScenario;
  readonly #executor: ProcessReactiveExecutor;
  readonly #timerHost: ProcessReactiveTimerHost;
  readonly #now: () => number;
  readonly #scenarioDeadlineAt: number;
  readonly #onDecision:
    | ((decision: ProcessReactiveDecision) => void)
    | undefined;
  #snapshot: ProcessReactiveSnapshot;
  readonly #pendingInputs: ProcessReactiveInput[] = [];
  #tail: Promise<void> = Promise.resolve();
  #running = false;
  #failure: unknown;
  #stateTimer: ProcessReactiveTimer | undefined;
  #scenarioTimer: ProcessReactiveTimer | undefined;
  #stateDeadlineAt = 0;
  #effectAbort: AbortController | undefined;
  #accepting = true;
  #closed = false;

  constructor(options: {
    readonly scenario: ProcessReactiveScenario;
    readonly executor: ProcessReactiveExecutor;
    readonly timerHost?: ProcessReactiveTimerHost;
    readonly now?: () => number;
    readonly onDecision?: (decision: ProcessReactiveDecision) => void;
  }) {
    this.#scenario = options.scenario;
    this.#executor = options.executor;
    this.#timerHost = options.timerHost ?? systemTimerHost;
    this.#now = options.now ?? Date.now;
    this.#scenarioDeadlineAt = this.#now() + options.scenario.deadline_ms;
    this.#onDecision = options.onDecision;
    this.#snapshot = createProcessReactiveSnapshot(options.scenario);
    this.#scheduleScenarioDeadline();
    this.#scheduleStateDeadline();
  }

  /** Current immutable reducer snapshot after all completed turns. */
  get snapshot(): ProcessReactiveSnapshot {
    return this.#snapshot;
  }

  /** Enqueue producer work without creating a floating promise. */
  enqueue(input: ProcessReactiveInput): void {
    if (!this.#accepting) return;
    if (this.#interruptsEffects(input)) this.#effectAbort?.abort();
    this.#enqueueOwned(input);
  }

  /** Submit one input and wait until every turn queued before it completes. */
  async submit(input: ProcessReactiveInput): Promise<ProcessReactiveSnapshot> {
    this.enqueue(input);
    await this.drain();
    return this.#snapshot;
  }

  /** Wait for currently queued reducer/effect work and surface host failures. */
  async drain(): Promise<void> {
    for (;;) {
      const observedTail = this.#tail;
      await observedTail;
      if (observedTail === this.#tail) break;
    }
    if (this.#failure !== undefined) throw this.#failure;
  }

  /** Stop owned deadlines after queued work settles. */
  async close(): Promise<void> {
    this.#accepting = false;
    this.#clearTimers();
    await this.drain();
    this.#closed = true;
  }

  #enqueueOwned(input: ProcessReactiveInput): void {
    if (this.#closed || this.#failure !== undefined) return;
    this.#pendingInputs.push(input);
    this.#startWorker();
  }

  #startWorker(): void {
    if (this.#running || this.#pendingInputs.length === 0) return;
    this.#running = true;
    this.#tail = this.#runQueue()
      .catch((cause: unknown) => this.#fail(cause))
      .finally(() => {
        this.#running = false;
        if (this.#pendingInputs.length > 0) this.#startWorker();
      });
  }

  async #runQueue(): Promise<void> {
    for (;;) {
      const input = this.#nextInput();
      if (input === undefined) return;
      await this.#advance(input);
    }
  }

  #nextInput(): ProcessReactiveInput | undefined {
    const terminalIndex = this.#pendingInputs.findIndex(
      ({ kind }) => kind === "cancelled" || kind === "cleanup_failed",
    );
    if (terminalIndex >= 0)
      return this.#pendingInputs.splice(terminalIndex, 1)[0];
    let observationIndex = -1;
    let captureOrder = Number.POSITIVE_INFINITY;
    for (const [index, input] of this.#pendingInputs.entries())
      if (
        input.kind === "observation" &&
        input.observation.capture_order < captureOrder
      ) {
        observationIndex = index;
        captureOrder = input.observation.capture_order;
      }
    return observationIndex >= 0
      ? this.#pendingInputs.splice(observationIndex, 1)[0]
      : this.#pendingInputs.shift();
  }

  #fail(cause: unknown): void {
    this.#failure ??= cause;
    this.#accepting = false;
    this.#closed = true;
    this.#effectAbort?.abort();
    this.#pendingInputs.length = 0;
    this.#clearTimers();
  }

  async #advance(input: ProcessReactiveInput): Promise<void> {
    const before = this.#snapshot;
    let decision = reduceProcessReactiveScenario(this.#scenario, before, input);
    let effectResults: readonly ProcessReactiveEffectResult[] = [];
    if (decision.kind === "proposal") {
      const effectAbort = new AbortController();
      this.#effectAbort = effectAbort;
      try {
        effectResults = await this.#executor.execute(
          decision.effects,
          effectAbort.signal,
        );
      } catch (cause: unknown) {
        if (effectAbort.signal.aborted) return;
        throw cause;
      } finally {
        if (this.#effectAbort === effectAbort) this.#effectAbort = undefined;
      }
      if (effectAbort.signal.aborted) return;
      const expired = this.#expiredDeadlineInput();
      if (expired !== undefined) {
        this.#enqueueOwned(expired);
        return;
      }
      decision = commitProcessReactiveProposal(
        this.#scenario,
        decision,
        effectResults,
      );
    }
    this.#snapshot = decision.snapshot;
    this.#onDecision?.(decision);
    if (this.#snapshot.status === "finished") this.#clearTimers();
    else if (
      this.#accepting &&
      (before.active_state !== this.#snapshot.active_state ||
        before.state_entry_capture_order !==
          this.#snapshot.state_entry_capture_order)
    )
      this.#scheduleStateDeadline();
    for (const result of effectResults)
      if (result.status === "succeeded")
        this.#enqueueOwned({
          kind: "observation",
          observation: result.observation,
        });
  }

  #interruptsEffects(input: ProcessReactiveInput): boolean {
    if (
      input.kind === "cancelled" ||
      input.kind === "cleanup_failed" ||
      input.kind === "scenario_deadline"
    )
      return true;
    return (
      input.kind === "state_deadline" &&
      input.state_id === this.#snapshot.active_state &&
      input.state_entry_capture_order ===
        this.#snapshot.state_entry_capture_order
    );
  }

  #expiredDeadlineInput(): ProcessReactiveInput | undefined {
    const now = this.#now();
    if (now >= this.#scenarioDeadlineAt) return { kind: "scenario_deadline" };
    if (now < this.#stateDeadlineAt) return undefined;
    return {
      kind: "state_deadline",
      state_id: this.#snapshot.active_state,
      state_entry_capture_order: this.#snapshot.state_entry_capture_order,
    };
  }

  #scheduleScenarioDeadline(): void {
    if (!this.#accepting) return;
    this.#scenarioTimer = this.#timerHost.schedule(
      () => this.enqueue({ kind: "scenario_deadline" }),
      this.#scenario.deadline_ms,
    );
  }

  #scheduleStateDeadline(): void {
    if (!this.#accepting) return;
    this.#stateTimer?.cancel();
    const state = this.#scenario.states.find(
      ({ id }) => id === this.#snapshot.active_state,
    );
    if (state === undefined) return;
    this.#stateDeadlineAt = this.#now() + state.deadline_ms;
    const identity = {
      state_id: state.id,
      state_entry_capture_order: this.#snapshot.state_entry_capture_order,
    };
    this.#stateTimer = this.#timerHost.schedule(
      () => this.enqueue({ kind: "state_deadline", ...identity }),
      state.deadline_ms,
    );
  }

  #clearTimers(): void {
    this.#stateTimer?.cancel();
    this.#scenarioTimer?.cancel();
    this.#stateTimer = undefined;
    this.#scenarioTimer = undefined;
  }
}
