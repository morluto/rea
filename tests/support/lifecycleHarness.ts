import { awaitAcknowledgement } from "../fixtures/lifecycleAcknowledgement.js";

/**
 * Controls for the scenarios in
 * docs/development/testing.md#lifecycle-regressions that a fixed delay cannot
 * establish: a late handshake or work still in flight at close (`phaseGate`),
 * cancellation during final cleanup (`cancelDuringCleanup`), and mixed child
 * cleanup outcomes with retry (`controlledCleanup`).
 */

/**
 * A phase boundary the test holds open. The code under test calls `hold` at
 * the boundary and waits there; the test waits until the boundary is
 * `reached`, acts (closes, cancels, lets a deadline pass), then `release`s it.
 */
export interface PhaseGate<T = void> {
  /** Called by the code under test: records arrival with `value`, then waits for release. */
  hold(value: T): Promise<void>;
  /**
   * Resolve with the held value once the boundary is reached. Fails if
   * `operation` settles first or the test wait deadline passes.
   */
  reached(operation: Promise<unknown>, boundary: string): Promise<T>;
  /** Let every current and later `hold` continue. Safe to call more than once. */
  release(): void;
}

export const phaseGate = <T = void>(): PhaseGate<T> => {
  let arrive!: (value: T) => void;
  const arrived = new Promise<T>((resolve) => {
    arrive = resolve;
  });
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    hold: async (value) => {
      arrive(value);
      await released;
    },
    reached: async (operation, boundary) => {
      await awaitAcknowledgement(
        arrived.then(() => {}),
        operation,
        boundary,
      );
      return arrived;
    },
    release,
  };
};

/**
 * One child cleanup whose outcome the test controls. Each `close` counts an
 * attempt, refuses with `failure` while refused, and otherwise runs its
 * `release` (the real close, or a gate's `hold`). Two of them with different
 * outcomes cover mixed child outcomes; `allow` then a retried close covers
 * cleanup retry, and `attempts` shows a confirmed peer is not closed again.
 */
export interface ControlledCleanup {
  readonly attempts: number;
  /** Stop refusing: the next attempt runs its release. */
  allow(): void;
  close(release?: () => unknown): Promise<void>;
}

export const controlledCleanup = ({
  refused = false,
  failure = new Error("controlled cleanup refusal"),
}: {
  readonly refused?: boolean;
  readonly failure?: unknown;
} = {}): ControlledCleanup => {
  let attempts = 0;
  let refusing = refused;
  return {
    get attempts() {
      return attempts;
    },
    allow: () => {
      refusing = false;
    },
    close: async (release) => {
      attempts++;
      if (refusing) throw failure;
      await release?.();
    },
  };
};

/**
 * A final cleanup step that observes cancellation: it aborts `controller`
 * with `reason` (whose identity the test asserts afterwards), then runs
 * `cleanup`. A cancellation during active work does not cover this phase.
 */
export const cancelDuringCleanup =
  <T>(
    controller: AbortController,
    reason: unknown,
    cleanup?: () => T | Promise<T>,
  ): (() => Promise<T | undefined>) =>
  async () => {
    controller.abort(reason);
    return cleanup?.();
  };

/** The rejection of `operation`, or `undefined` once it fulfils. */
export const settledCause = (operation: Promise<unknown>): Promise<unknown> =>
  operation.then(
    () => undefined,
    (cause: unknown) => cause,
  );
