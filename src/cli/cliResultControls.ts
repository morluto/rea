import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The per-call controls a CLI result records by contract field, each with the
 * option that sets it on the command that ran. The CLI renders this map in
 * its own envelope (`meta.cli_controls`); the result itself, and any Evidence
 * in it, stays exactly as the service produced it.
 */
export type CliResultControls = Readonly<Record<string, string>>;

interface ControlsContext {
  /** Collects the controls on demand: only a full-output envelope shows them. */
  collect?: () => CliResultControls;
}
const invocation = new AsyncLocalStorage<ControlsContext>();

/** Keep the controls in the invocation that owns the command and its output. */
export const withCliResultControls = <Value>(run: () => Value): Value =>
  invocation.run({}, run);

export const recordCliResultControls = (
  collect: () => CliResultControls,
): void => {
  const context = invocation.getStore();
  if (context !== undefined) context.collect = collect;
};

/**
 * This invocation's recorded controls, or undefined when its result records
 * none. The result is read only when this is called.
 */
export const cliResultControls = (): CliResultControls | undefined => {
  const controls = invocation.getStore()?.collect?.();
  return controls === undefined || Object.keys(controls).length === 0
    ? undefined
    : controls;
};
