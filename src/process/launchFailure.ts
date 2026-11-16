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

/** The host resource a launch could not obtain. */
export type LaunchExhaustedResource =
  | "processes"
  | "memory"
  | "file-descriptors";

const HOST_EXHAUSTION: Readonly<Record<string, LaunchExhaustedResource>> = {
  EAGAIN: "processes",
  ENOMEM: "memory",
  EMFILE: "file-descriptors",
  ENFILE: "file-descriptors",
};

/**
 * The host resource a spawn errno reports as exhausted; undefined for any
 * other errno. The selected command may be usable once capacity is freed.
 */
export const launchExhaustedResource = (
  code: unknown,
): LaunchExhaustedResource | undefined =>
  typeof code === "string" && Object.hasOwn(HOST_EXHAUSTION, code)
    ? HOST_EXHAUSTION[code]
    : undefined;

/**
 * Why a process did not start, classified once by errno:
 *
 * - a launch refusal (`missing`, `not_executable`): the selected executable
 *   cannot be run;
 * - `host-exhausted`: the host lacked process, memory or file-descriptor
 *   capacity (EAGAIN, ENOMEM, EMFILE, ENFILE);
 * - `argument-list`: the request's argument list and environment exceed the
 *   launch limit (E2BIG);
 * - `failed`: any other errno, or none; the provider cannot be started.
 */
export type LaunchFailure =
  | LaunchRefusal
  | {
      readonly kind: "host-exhausted";
      readonly code: string;
      readonly resource: LaunchExhaustedResource;
    }
  | { readonly kind: "argument-list"; readonly code: "E2BIG" }
  | { readonly kind: "failed"; readonly code: string | undefined };

/** Classify any spawn errno; see `LaunchFailure`. */
export const classifyLaunchErrno = (code: unknown): LaunchFailure => {
  const refusal = classifyLaunchFailureCode(code);
  if (refusal !== undefined) return refusal;
  const resource = launchExhaustedResource(code);
  if (resource !== undefined && typeof code === "string")
    return { kind: "host-exhausted", code, resource };
  if (code === "E2BIG") return { kind: "argument-list", code };
  return { kind: "failed", code: typeof code === "string" ? code : undefined };
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

/**
 * A launch failure a launcher raised. `executable` names the executable when
 * the launcher named it, undefined when it did not (Node's bare `spawn`);
 * `syscall` is the launcher's own label, such as `spawn /usr/bin/tool`.
 */
export type LauncherFailure = LaunchFailure & {
  readonly executable: string | undefined;
  readonly syscall: string | undefined;
};

/**
 * Whether a launcher raised this error while starting a process, and the
 * executable it named: Node's `spawn` or `spawn <path>` error, or the Windows
 * native launcher's executable-launch constraint. Undefined when no launcher
 * raised it, such as an errno from reading a file or preparing ownership.
 */
const launcherIdentityOf = (
  cause: Error,
): { readonly executable: string | undefined } | undefined => {
  const syscall = Reflect.get(cause, "syscall");
  if (typeof syscall === "string" && /^spawn(?: |$)/u.test(syscall)) {
    const path = Reflect.get(cause, "path");
    return {
      executable:
        typeof path === "string" && syscall === `spawn ${path}`
          ? path
          : undefined,
    };
  }
  const requestedPath = windowsExecutableLaunchPath(cause);
  return requestedPath === undefined
    ? undefined
    : { executable: requestedPath };
};

/**
 * Classify a launcher's failure to start an executable, by errno. Undefined
 * when no launcher raised the error, such as an errno from reading a file or
 * preparing process ownership.
 */
export const launcherFailureOf = (
  cause: unknown,
): LauncherFailure | undefined => {
  if (!(cause instanceof Error)) return undefined;
  const identity = launcherIdentityOf(cause);
  if (identity === undefined) return undefined;
  const syscall = Reflect.get(cause, "syscall");
  return {
    ...classifyLaunchErrno(Reflect.get(cause, "code")),
    ...identity,
    syscall: typeof syscall === "string" ? syscall : undefined,
  };
};

/**
 * How a launch failure reads in a report: the errno, and the launcher's
 * syscall for a failure that is neither a refusal nor a host constraint.
 */
export const describeLaunchFailure = (failure: LauncherFailure): string => {
  const code = failure.code ?? "no system code";
  return failure.kind === "failed" && failure.syscall !== undefined
    ? `${code} from ${failure.syscall}`
    : code;
};
