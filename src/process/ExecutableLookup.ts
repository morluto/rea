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
  /** A relative command or PATH entry needed the working directory, which could not be read. */
  | { readonly status: "no-working-directory"; readonly cause: unknown }
  /** The caller's signal or deadline ended the lookup before it finished. */
  | {
      readonly status: "interrupted";
      readonly by: "cancellation" | "deadline";
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
 * a match. The working directory is read only for a relative command or PATH
 * entry, since it may have been removed. A file-system call cannot itself be
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
  let candidates: string[];
  try {
    // Match Node's Unix default search path when PATH is absent.
    candidates = explicit
      ? [located(command)]
      : (searchPath ?? "/usr/bin:/bin")
          .split(delimiter)
          .map((directory) => appendCallerPath(located(directory), command));
  } catch (cause) {
    return { status: "no-working-directory", cause };
  }
  const interruption = lookupInterruption(signal, timeoutMs);
  try {
    const checked: string[] = [];
    for (const candidate of candidates) {
      const metadata = await interruption.race(stat(candidate));
      if (metadata.status === "interrupted") return metadata;
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
      if (executable.status === "interrupted") return executable;
      if (executable.status === "fulfilled")
        return { status: "found", path: candidate };
      checked.push(
        `${candidate}${systemErrorSuffix(systemErrorCode(executable.cause))}`,
      );
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

const systemErrorCode = (cause: unknown): string | undefined =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  typeof cause.code === "string"
    ? cause.code
    : undefined;

const systemErrorSuffix = (code: string | undefined): string =>
  code === undefined ? "" : ` (${code})`;
