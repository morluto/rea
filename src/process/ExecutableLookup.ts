import type { Stats } from "node:fs";
import { constants as fsConstants } from "node:fs";
import { access, stat as statPath } from "node:fs/promises";
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
  /** A relative command, or a relative PATH entry with no later match, needed the working directory, which could not be read. */
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
}

/**
 * Resolve a command the way process spawning searches for it. A command that
 * contains a path separator is the selected path; PATH search continues past
 * denied directories, and an existing file without execute permission is not
 * a match. The working directory is read only when the search reaches a
 * relative command or PATH entry, since it may have been removed. When that
 * read fails, the search skips the relative entry, as a spawned search finds
 * nothing under a removed directory, and reports the unread working directory
 * only if no later entry matches. A file-system call cannot itself be
 * cancelled, so an interrupted lookup stops waiting for it and lets it settle
 * unobserved.
 */
export const lookupExecutable = async (
  command: string,
  workingDirectory: () => string,
  searchPath: string | undefined,
  bounds: ExecutableLookupBounds = {},
): Promise<ExecutableLookup> => {
  const { signal, timeoutMs, stat = statPath } = bounds;
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
    // A relative PATH entry skipped because the working directory could not
    // be read; without a later match, the command is not known to be missing.
    let skipped: { readonly cause: unknown } | undefined;
    for (const entry of entries) {
      // Resolved only when reached: a match in an earlier entry never needs
      // the working directory that a later relative entry would read.
      let candidate: string;
      try {
        candidate = explicit
          ? located(entry)
          : appendCallerPath(located(entry), command);
      } catch (cause) {
        // An explicit relative command has no other candidate.
        if (explicit) return { status: "no-working-directory", cause };
        skipped ??= { cause };
        checked.push(
          `${appendCallerPath(entry === "" ? "." : entry, command)} (working directory unreadable)`,
        );
        continue;
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
        continue;
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
      if (executable.status === "fulfilled")
        return { status: "found", path: candidate };
      checked.push(
        `${candidate}${systemErrorSuffix(systemErrorCode(executable.cause))}`,
      );
    }
    return skipped === undefined
      ? { status: "missing", checked }
      : { status: "no-working-directory", cause: skipped.cause };
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

const systemErrorCode = (cause: unknown): string | undefined =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  typeof cause.code === "string"
    ? cause.code
    : undefined;

const systemErrorSuffix = (code: string | undefined): string =>
  code === undefined ? "" : ` (${code})`;
