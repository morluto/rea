/**
 * The error Node's `spawn` emits when it cannot start `command`: the errno as
 * `code`, `syscall: "spawn <command>"` and `path`. Owned supervision rethrows
 * a launcher's error unchanged, and the shared launch owner recognises only
 * this launcher-raised shape, so test launchers throw it rather than a bare
 * errno.
 */
export const spawnFailure = (code: string, command = "provider"): Error =>
  Object.assign(new Error(`spawn ${command} ${code}`), {
    code,
    syscall: `spawn ${command}`,
    path: command,
  });
