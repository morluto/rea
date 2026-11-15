import { windowsExecutableLaunchPath } from "../windows/WindowsOwnedProcess.js";

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

/**
 * Name the executable on an errno Node threw synchronously from `spawn`.
 * Node emits ENOENT and EACCES as `spawn <path>` with `path`, but throws
 * other refusals such as ENOEXEC and ENOTDIR with a bare `spawn` syscall;
 * the launcher that passed `command` gives them the emitted shape.
 */
export const nameSpawnedExecutable = (
  cause: unknown,
  command: string,
): unknown => {
  if (
    cause instanceof Error &&
    Reflect.get(cause, "syscall") === "spawn" &&
    Reflect.get(cause, "path") === undefined
  ) {
    Reflect.set(cause, "syscall", `spawn ${command}`);
    Reflect.set(cause, "path", command);
  }
  return cause;
};

/** A launch refusal together with the executable the launcher named. */
export interface ExecutableLaunchRefusal extends LaunchRefusal {
  readonly executable: string;
}

/**
 * The executable a launcher named when it failed to start it: Node's
 * `spawn <path>` error or the Windows native launcher's executable-launch
 * constraint. Undefined when the error does not identify a launch.
 */
const launchedExecutableOf = (cause: Error): string | undefined => {
  const path = Reflect.get(cause, "path");
  if (
    typeof path === "string" &&
    Reflect.get(cause, "syscall") === `spawn ${path}`
  )
    return path;
  return windowsExecutableLaunchPath(cause);
};

/**
 * Classify a failure to start a named executable. Undefined when the errno is
 * not a launch refusal or the error does not identify the executable a
 * launcher refused, such as an errno from reading a file or preparing
 * ownership.
 */
export const executableLaunchRefusalOf = (
  cause: unknown,
): ExecutableLaunchRefusal | undefined => {
  if (!(cause instanceof Error)) return undefined;
  const executable = launchedExecutableOf(cause);
  if (executable === undefined) return undefined;
  const refusal = classifyLaunchFailure(cause);
  return refusal === undefined ? undefined : { ...refusal, executable };
};
