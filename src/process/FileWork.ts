/** How a wait for one step of file work ended. */
export type FileWorkOutcome<Value> =
  | { readonly status: "fulfilled"; readonly value: Value }
  | { readonly status: "rejected"; readonly cause: unknown }
  | {
      readonly status: "interrupted";
      readonly by: "cancellation" | "deadline";
    }
  /** The owner already holds its budget of stalled steps; nothing started. */
  | {
      readonly status: "saturated";
      readonly held: number;
      readonly budget: number;
    };

/** One deadline and abort listener shared by every step of a file task. */
export interface FileWorkDeadline {
  /** How the deadline or cancellation ended the task, once one has. */
  readonly ended: "cancellation" | "deadline" | undefined;
  /** Wait for a step until it settles or the task ends. */
  readonly race: <Value>(
    operation: Promise<Value>,
  ) => Promise<FileWorkOutcome<Value>>;
  readonly release: () => void;
}

export const fileWorkDeadline = (
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): FileWorkDeadline => {
  let ended: "cancellation" | "deadline" | undefined;
  let interrupt: ((by: "cancellation" | "deadline") => void) | undefined;
  const interrupted = new Promise<"cancellation" | "deadline">((resolve) => {
    interrupt = (by) => {
      ended ??= by;
      resolve(by);
    };
  });
  const cancel = (): void => interrupt?.("cancellation");
  const timer =
    timeoutMs === undefined
      ? undefined
      : setTimeout(() => interrupt?.("deadline"), timeoutMs);
  if (signal?.aborted === true) cancel();
  else signal?.addEventListener("abort", cancel, { once: true });
  return {
    get ended() {
      return ended;
    },
    race: <Value>(operation: Promise<Value>) =>
      Promise.race([
        operation.then(
          (value): FileWorkOutcome<Value> => ({ status: "fulfilled", value }),
          (cause: unknown): FileWorkOutcome<Value> => ({
            status: "rejected",
            cause,
          }),
        ),
        interrupted.then((by): FileWorkOutcome<Value> => ({
          status: "interrupted",
          by,
        })),
      ]),
    release: () => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
    },
  };
};

const ignore = (): void => undefined;

/**
 * Stalled steps one process holds before it refuses new file work. Each holds
 * a thread of libuv's pool, which Node sizes at 4 and REA does not resize, so
 * two stay free for every other file, DNS and compression call.
 */
export const MAX_HELD_FILE_STEPS = 2;

/** Work left behind on one path, and the calls waiting for it to settle. */
interface LeftWork {
  readonly steps: Set<Promise<void>>;
  /** Each wakes one waiting call, which removes it when it stops waiting. */
  readonly waiters: Set<() => void>;
}

/** What every scope of one owner shares. */
interface Owner {
  /** Work left behind, by path. */
  readonly left: Map<string, LeftWork>;
  readonly budget: number;
  /** Left-behind steps that have not returned. */
  held: number;
}

/**
 * The owner of file-system work that its caller cannot cancel. A stalled mount
 * holds a `stat`, an `access` or a stream's open, read or close, and a libuv
 * worker with it, until the mount answers. A caller that stops waiting leaves
 * that work behind, and later work on the same path waits for it to settle
 * instead of starting more, so stalled work stays bounded by the paths. Work
 * that was not left behind never makes other work wait. Once the owner holds
 * `budget` stalled steps, it refuses to start more until one returns.
 *
 * Each scope shares its owner's record of left-behind work and also keeps
 * the work it left itself, so a caller can hold resources, such as its place
 * among concurrent operations, until that work settles.
 */
export class FileWork {
  #owner: Owner;
  /** Work this scope left behind. */
  readonly #own = new Set<Promise<void>>();

  constructor(budget = MAX_HELD_FILE_STEPS) {
    this.#owner = { left: new Map(), budget, held: 0 };
  }

  /** A scope that waits for, and is waited for by, this owner's other scopes. */
  scope(): FileWork {
    const scope = new FileWork(this.#owner.budget);
    scope.#owner = this.#owner;
    return scope;
  }

  /** Stalled steps this owner holds. */
  get held(): number {
    return this.#owner.held;
  }

  /**
   * Start one step on `path` once the work left behind on that path has
   * settled, and wait for it within `deadline`. A step that the deadline or
   * cancellation interrupts is left behind with this scope.
   */
  async run<Value>(
    path: string,
    deadline: FileWorkDeadline,
    start: () => Promise<Value>,
  ): Promise<FileWorkOutcome<Value>> {
    for (
      let earlier = this.#owner.left.get(path);
      earlier !== undefined;
      earlier = this.#owner.left.get(path)
    ) {
      // A waiter the call removes, since a reaction on the left-behind work
      // would stay attached after the call stops waiting.
      let wake!: () => void;
      const settled = new Promise<void>((resolve) => {
        wake = resolve;
      });
      earlier.waiters.add(wake);
      const waited = await deadline.race(settled);
      earlier.waiters.delete(wake);
      if (waited.status === "interrupted") return waited;
    }
    if (deadline.ended !== undefined)
      return { status: "interrupted", by: deadline.ended };
    const { held, budget } = this.#owner;
    if (held >= budget) return { status: "saturated", held, budget };
    let step: Promise<Value>;
    try {
      step = start();
    } catch (cause) {
      return { status: "rejected", cause };
    }
    const outcome = await deadline.race(step);
    if (outcome.status === "interrupted") this.#leave(path, step);
    return outcome;
  }

  /** Settles once the work this scope left behind has; undefined when it left none. */
  get left(): Promise<void> | undefined {
    return this.#own.size === 0
      ? undefined
      : Promise.all(this.#own).then(ignore);
  }

  #leave(path: string, step: Promise<unknown>): void {
    const settled = step.then(ignore, ignore);
    const held = this.#owner.left.get(path) ?? {
      steps: new Set(),
      waiters: new Set(),
    };
    this.#owner.left.set(path, held);
    held.steps.add(settled);
    this.#own.add(settled);
    this.#owner.held += 1;
    void settled.then(() => {
      held.steps.delete(settled);
      this.#own.delete(settled);
      this.#owner.held -= 1;
      if (held.steps.size > 0) return;
      if (this.#owner.left.get(path) === held) this.#owner.left.delete(path);
      for (const wake of held.waiters) wake();
    });
  }
}

/** The process's one owner, since libuv's pool belongs to the process. */
export const HOST_FILE_WORK = new FileWork();

/** A step refused because the owner holds its budget of stalled steps. */
export class FileWorkSaturatedError extends Error {
  readonly _tag = "FileWorkSaturatedError";

  constructor(
    readonly path: string,
    readonly held: number,
    readonly budget: number,
  ) {
    super(
      `${String(held)} file-system steps that an unresponsive mount has not returned already hold REA's budget of ${String(budget)}`,
    );
    this.name = "FileWorkSaturatedError";
  }
}
