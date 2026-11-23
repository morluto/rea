/**
 * SIGINT and SIGTERM for one verifier command owner.
 *
 * Owned commands run in their own process group, so the terminal signal does
 * not reach them. These handlers abort that work instead of letting Node exit.
 * They stay installed until `finish`, which is after fixture release: removing
 * them earlier restores Node's default termination while cleanup is still
 * closing a detached process.
 *
 * `untilInterrupted` always observes the promise the caller already started.
 * When the signal is already aborted, that interrupt is the result and a later
 * settlement of the started promise is ignored.
 *
 * @param {{
 *   exec: (
 *     command: string,
 *     args: readonly string[],
 *     options?: object,
 *   ) => Promise<unknown>;
 * }} commands
 */
export function bindVerifierCommandInterruption(commands) {
  const controller = new AbortController();
  const interrupt = (signal) =>
    controller.abort(new Error(`Verifier interrupted by ${signal}`));
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  const signal = controller.signal;

  return {
    signal,
    exec: (command, args, options = {}) =>
      commands.exec(command, args, { ...options, signal }),
    throwIfInterrupted: () => {
      if (signal.aborted) throw signal.reason;
    },
    /**
     * The interrupt reason without removing the handlers. Fixture release still
     * needs them so a late signal cannot skip cleanup.
     */
    reason: () => (signal.aborted ? signal.reason : undefined),
    /** Remove the handlers after fixture release has finished. */
    finish: () => {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", interrupt);
      return signal.aborted ? signal.reason : undefined;
    },
    /**
     * Register this after every other release callback. It runs after those
     * checks and before the fixture root is removed, so a signal during
     * finalization keeps the diagnostic workspace.
     */
    retainWorkspaceIfInterrupted: (fixture) => {
      fixture.releaseAfter(() => {
        if (signal.aborted) throw signal.reason;
      });
    },
    untilInterrupted: (promise) =>
      new Promise((resolve, reject) => {
        let settled = false;
        const finish = (settle, value) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", onAbort);
          settle(value);
        };
        const onAbort = () => finish(reject, signal.reason);
        // The caller starts `promise` before this check. Observe it even when
        // the signal is already aborted so its later rejection cannot end the
        // process. The interrupt wins.
        if (signal.aborted) finish(reject, signal.reason);
        else signal.addEventListener("abort", onAbort, { once: true });
        Promise.resolve(promise).then(
          (value) => finish(resolve, value),
          (cause) => finish(reject, cause),
        );
      }),
  };
}
