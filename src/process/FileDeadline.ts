/** How a wait for one file-system step ended. */
export type FileStepOutcome<Value> =
  | { readonly status: "fulfilled"; readonly value: Value }
  | { readonly status: "rejected"; readonly cause: unknown }
  | {
      readonly status: "interrupted";
      readonly by: "cancellation" | "deadline";
    };

/** One deadline and abort listener shared by every step of a file task. */
export interface FileDeadline {
  /** How the deadline or cancellation ended the task, once one has. */
  readonly ended: "cancellation" | "deadline" | undefined;
  /**
   * Start one step, unless the task has already ended, and wait for it until
   * it settles or the task ends. A file-system call cannot be cancelled, so a
   * step the task stops waiting for keeps running until its mount answers.
   */
  readonly run: <Value>(
    start: () => Promise<Value>,
  ) => Promise<FileStepOutcome<Value>>;
  readonly release: () => void;
}

export const fileDeadline = (
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): FileDeadline => {
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
    run: async <Value>(start: () => Promise<Value>) => {
      if (ended !== undefined)
        return { status: "interrupted", by: ended } as const;
      let step: Promise<Value>;
      try {
        step = start();
      } catch (cause) {
        return { status: "rejected", cause } as const;
      }
      return Promise.race([
        step.then(
          (value): FileStepOutcome<Value> => ({ status: "fulfilled", value }),
          (cause: unknown): FileStepOutcome<Value> => ({
            status: "rejected",
            cause,
          }),
        ),
        interrupted.then((by): FileStepOutcome<Value> => ({
          status: "interrupted",
          by,
        })),
      ]);
    },
    release: () => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
    },
  };
};
