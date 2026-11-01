import type { Stats } from "node:fs";
import { constants as fsConstants } from "node:fs";
import { access as accessPath, stat as statPath } from "node:fs/promises";
import { delimiter, isAbsolute, sep } from "node:path";

import {
  absoluteCallerPath,
  appendCallerPath,
} from "../filesystem/callerPath.js";

/** Where a command resolves through an effective PATH, or why it does not. */
export type ExecutableLookup =
  | { readonly status: "found"; readonly path: string }
  /** The host refused to inspect an explicitly selected path. */
  | {
      readonly status: "denied";
      readonly path: string;
      readonly code: "EACCES" | "EPERM";
      readonly cause: unknown;
    }
  | { readonly status: "missing"; readonly checked: readonly string[] }
  /** A relative command, or a match under a relative PATH entry, needed the working directory, which could not be read. */
  | { readonly status: "no-working-directory"; readonly cause: unknown }
  /** The caller's signal or deadline ended the lookup before it finished. */
  | {
      readonly status: "interrupted";
      readonly by: "cancellation" | "deadline";
      /** The path being checked when the lookup stopped. */
      readonly candidate: string;
    };

/** Optional bounds for one lookup. */
export interface ExecutableLookupBounds {
  readonly signal?: AbortSignal | undefined;
  /** Milliseconds for the whole lookup. */
  readonly timeoutMs?: number | undefined;
  readonly stat?: (path: string) => Promise<Stats>;
  readonly access?: (path: string, mode: number) => Promise<void>;
}

/**
 * Resolve a command the way process spawning searches for it. A command that
 * contains a path separator is the selected path; PATH search continues past
 * a missing file, a non-directory and a denied directory, and an existing file
 * without execute permission is not a match. Any other error, such as a
 * symlink loop, ends the search, as it ends a spawned search, while on Linux
 * and macOS an entry too long for the native path buffer is skipped before it
 * is checked, as their spawned searches skip it. Where native searches differ,
 * the lookup stops, so a launch by name lets the host's own search decide. The
 * working directory is read only when the search reaches a
 * relative command or PATH entry, since it may have been removed. When that
 * read fails, a relative PATH entry is checked as written, against the
 * process's working directory, which the kernel still resolves (even `..`
 * from a removed directory), as a spawned search does: an entry without the
 * executable lets the search continue, and a match there ends it with
 * `no-working-directory`, since its absolute path cannot be named. So
 * `workingDirectory` must name the process's working directory whenever it
 * can fail. A file-system call cannot itself be cancelled, so an interrupted
 * lookup stops waiting for it and lets it settle unobserved.
 */
export const lookupExecutable = async (
  command: string,
  workingDirectory: () => string,
  searchPath: string | undefined,
  bounds: ExecutableLookupBounds = {},
): Promise<ExecutableLookup> => {
  const { signal, timeoutMs, stat = statPath, access = accessPath } = bounds;
  let cwd: string | undefined;
  const readCwd = (): string => (cwd ??= workingDirectory());
  // An empty PATH component selects the working directory. Windows resolves
  // even an absolute path against the working directory's drive.
  const located = (path: string): string =>
    path === ""
      ? readCwd()
      : process.platform !== "win32" && isAbsolute(path)
        ? absoluteCallerPath(path)
        : absoluteCallerPath(path, { cwd: readCwd() });
  const explicit =
    isAbsolute(command) ||
    command.includes("/") ||
    (sep === "\\" && command.includes("\\"));
  // Match Node's Unix default search path when PATH is absent.
  const entries = explicit
    ? [command]
    : (searchPath ?? "/usr/bin:/bin").split(delimiter);
  const interruption = lookupInterruption(signal, timeoutMs);
  try {
    const checked: string[] = [];
    for (const entry of entries) {
      const entryBytes = Buffer.byteLength(entry);
      if (!explicit && PATH_MAX !== undefined && entryBytes >= PATH_MAX) {
        checked.push(`a PATH entry of ${entryBytes} bytes (skipped)`);
        continue;
      }
      // Resolved only when reached: a match in an earlier entry never needs
      // the working directory that a later relative entry would read.
      let candidate: string;
      // Set when the working directory could not be read, so the candidate
      // is the relative path as written.
      let unnamed: { readonly cause: unknown } | undefined;
      try {
        candidate = explicit
          ? located(entry)
          : appendCallerPath(located(entry), command);
      } catch (cause) {
        // An explicit relative command has no other candidate.
        if (explicit) return { status: "no-working-directory", cause };
        candidate = appendCallerPath(entry === "" ? "." : entry, command);
        unnamed = { cause };
      }
      const metadata = await interruption.race(stat(candidate));
      if (metadata.status === "interrupted") return { ...metadata, candidate };
      if (metadata.status === "rejected") {
        const code = systemErrorCode(metadata.cause);
        if (explicit && (code === "EACCES" || code === "EPERM"))
          return {
            status: "denied",
            path: candidate,
            code,
            cause: metadata.cause,
          };
        checked.push(`${candidate}${systemErrorSuffix(code)}`);
        if (searchMovesPast(code)) continue;
        return { status: "missing", checked };
      }
      if (!metadata.value.isFile()) {
        checked.push(`${candidate} (not a regular file)`);
        continue;
      }
      const executable = await interruption.race(
        access(candidate, fsConstants.X_OK),
      );
      if (executable.status === "interrupted")
        return { ...executable, candidate };
      // A launch by name would run a match under an unnamed working
      // directory, so the search stops there without a path to report.
      if (executable.status === "fulfilled")
        return unnamed === undefined
          ? { status: "found", path: candidate }
          : { status: "no-working-directory", cause: unnamed.cause };
      const code = systemErrorCode(executable.cause);
      checked.push(`${candidate}${systemErrorSuffix(code)}`);
      if (!searchMovesPast(code)) return { status: "missing", checked };
    }
    return { status: "missing", checked };
  } finally {
    interruption.release();
  }
};

type Raced<Value> =
  | { readonly status: "fulfilled"; readonly value: Value }
  | { readonly status: "rejected"; readonly cause: unknown }
  | {
      readonly status: "interrupted";
      readonly by: "cancellation" | "deadline";
    };

/** One deadline and abort listener shared by every file-system call of a lookup. */
const lookupInterruption = (
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): {
  readonly race: <Value>(operation: Promise<Value>) => Promise<Raced<Value>>;
  readonly release: () => void;
} => {
  let interrupt: ((by: "cancellation" | "deadline") => void) | undefined;
  const interrupted = new Promise<"cancellation" | "deadline">((resolve) => {
    interrupt = resolve;
  });
  const cancel = (): void => interrupt?.("cancellation");
  const timer =
    timeoutMs === undefined
      ? undefined
      : setTimeout(() => interrupt?.("deadline"), timeoutMs);
  if (signal?.aborted === true) cancel();
  else signal?.addEventListener("abort", cancel, { once: true });
  return {
    race: <Value>(operation: Promise<Value>) =>
      Promise.race([
        operation.then(
          (value): Raced<Value> => ({ status: "fulfilled", value }),
          (cause: unknown): Raced<Value> => ({ status: "rejected", cause }),
        ),
        interrupted.then((by): Raced<Value> => ({ status: "interrupted", by })),
      ]),
    release: () => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
    },
  };
};

/**
 * The errors every native PATH search moves past: glibc's and musl's execvp,
 * Android's bionic and libuv's own search on macOS. At any other error, such
 * as a symlink loop, a stale NFS handle or an I/O error, some of them stop,
 * so the lookup stops and the launch by name lets the host's search decide.
 */
const searchMovesPast = (code: string | undefined): boolean =>
  code === "ENOENT" || code === "ENOTDIR" || code === "EACCES";

/**
 * The PATH entry length, in bytes, from which the host's native search skips
 * an entry its path buffer cannot hold: execvp on Linux (glibc and musl) and
 * libuv on macOS. A shorter entry with an over-long component still fails
 * with ENAMETOOLONG. Elsewhere, as on Android, nothing is skipped by length.
 */
const PATH_MAX = (
  { linux: 4096, darwin: 1024 } as Partial<Record<NodeJS.Platform, number>>
)[process.platform];

const systemErrorCode = (cause: unknown): string | undefined =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  typeof cause.code === "string"
    ? cause.code
    : undefined;

const systemErrorSuffix = (code: string | undefined): string =>
  code === undefined ? "" : ` (${code})`;
