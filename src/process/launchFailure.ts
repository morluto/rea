/**
 * Why the operating system refused to start a selected executable.
 *
 * `missing`: nothing runnable resolves at the selected path.
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
  ELOOP: "missing",
  ENAMETOOLONG: "missing",
  EACCES: "not_executable",
  EPERM: "not_executable",
  ENOEXEC: "not_executable",
  EISDIR: "not_executable",
};

/** Classify a spawn errno; undefined when it is not a launch refusal. */
export const classifyLaunchFailureCode = (
  code: unknown,
): LaunchRefusal | undefined => {
  if (typeof code !== "string" || !Object.hasOwn(LAUNCH_REFUSALS, code))
    return undefined;
  const kind = LAUNCH_REFUSALS[code];
  return kind === undefined ? undefined : { kind, code };
};

/** Classify a spawn failure; undefined when it was not a launch refusal. */
export const classifyLaunchFailure = (
  cause: unknown,
): LaunchRefusal | undefined =>
  cause instanceof Error && "code" in cause
    ? classifyLaunchFailureCode(cause.code)
    : undefined;
