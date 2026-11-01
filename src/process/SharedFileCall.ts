/**
 * File-system calls still running, by function and path. A stalled mount
 * holds a call, and a libuv worker with it, until the mount answers, and a
 * caller that stops waiting cannot cancel it.
 */
const running = new WeakMap<object, Map<string, Promise<unknown>>>();

/**
 * Start a file-system call for a path, or join the call that `call` is still
 * running for it. Sharing bounds stalled work by the paths, not by the retries.
 */
export const shareFileCall = <Value>(
  call: object,
  path: string,
  start: () => Promise<Value>,
): Promise<Value> => {
  const calls = running.get(call) ?? new Map<string, Promise<unknown>>();
  running.set(call, calls);
  const pending = calls.get(path) as Promise<Value> | undefined;
  if (pending !== undefined) return pending;
  const started = start();
  calls.set(path, started);
  const settled = (): void => {
    if (calls.get(path) === started) calls.delete(path);
  };
  void started.then(settled, settled);
  return started;
};
