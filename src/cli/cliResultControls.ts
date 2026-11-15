import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The per-call controls a CLI result records by contract field, each with the
 * option that sets it on the command that ran. The CLI renders this map in
 * its own envelope (`meta.cli_controls`); the result itself, and any Evidence
 * in it, stays exactly as the service produced it.
 */
export type CliResultControls = Readonly<Record<string, string>>;

interface ControlsContext {
  controls?: CliResultControls;
}
const invocation = new AsyncLocalStorage<ControlsContext>();

/** Keep the controls in the invocation that owns the command and its output. */
export const withCliResultControls = <Value>(run: () => Value): Value =>
  invocation.run({}, run);

export const recordCliResultControls = (controls: CliResultControls): void => {
  const context = invocation.getStore();
  if (context !== undefined && Object.keys(controls).length > 0)
    context.controls = controls;
};

/** The controls this invocation's result recorded, if any. */
export const cliResultControls = (): CliResultControls | undefined =>
  invocation.getStore()?.controls;
