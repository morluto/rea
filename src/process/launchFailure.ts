/**
 * Why the operating system refused to start a selected executable.
 *
 * `missing`: nothing runnable exists at the selected path.
 * `not_executable`: something exists there but may not be run, including a
 * refusal by an operating-system security policy (EPERM).
 */
export interface LaunchRefusal {
  readonly kind: "missing" | "not_executable";
  readonly code: string;
}

const LAUNCH_REFUSALS: Readonly<Record<string, LaunchRefusal["kind"]>> = {
  ENOENT: "missing",
  ENOTDIR: "missing",
  EACCES: "not_executable",
  EPERM: "not_executable",
  ENOEXEC: "not_executable",
  EISDIR: "not_executable",
};

/** Classify a spawn failure; undefined when it was not a launch refusal. */
export const classifyLaunchFailure = (
  cause: unknown,
): LaunchRefusal | undefined => {
  if (!(cause instanceof Error) || !("code" in cause)) return undefined;
  const { code } = cause;
  if (typeof code !== "string" || !Object.hasOwn(LAUNCH_REFUSALS, code))
    return undefined;
  const kind = LAUNCH_REFUSALS[code];
  return kind === undefined ? undefined : { kind, code };
};
