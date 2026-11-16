import { posix, win32 } from "node:path";

import {
  absoluteCallerPath,
  appendCallerPath,
} from "../filesystem/callerPath.js";
import { err, ok, type Result } from "../domain/result.js";
import { snapshotEnvironment } from "./snapshotEnvironment.js";

/** One file a launcher tries for a bare command, in search order. */
export interface PathSearchCandidate {
  /** The absolute file the launch would execute from this entry. */
  readonly path: string;
  /**
   * An empty or relative PATH entry, or on Windows a rooted entry without a
   * drive (`\tools`), which depends on the working directory or its drive.
   */
  readonly relativeEntry: boolean;
}

/**
 * How entries that depend on the working directory are searched: `skip` leaves
 * them out; otherwise they resolve against `workingDirectory`, or against this
 * process's directory when omitted (read only when such an entry exists).
 */
export type RelativePathEntries =
  | { readonly relativeEntries: "skip" }
  | { readonly relativeEntries: "resolve"; readonly workingDirectory?: string };

/**
 * The files `execvp` tries for a bare command (one without `/`), in PATH
 * order: an empty entry names the working directory and a relative entry
 * resolves against it. `..` is kept for the filesystem to resolve after any
 * symbolic link. Each caller decides how a candidate is probed and how a
 * failed probe is reported; this owner fixes only the search order.
 * Candidates are produced on demand: stop iterating at the first match.
 * Several names are tried in each entry before the next entry.
 */
export function* posixPathCandidates(
  commands: string | readonly string[],
  searchPath: string,
  selection: RelativePathEntries,
): Generator<PathSearchCandidate, void, undefined> {
  // Lazy, so an entry after the first match is never resolved: resolving a
  // relative entry reads the working directory, which may no longer exist.
  for (const directory of searchPath.split(posix.delimiter)) {
    const relativeEntry = !posix.isAbsolute(directory);
    if (relativeEntry && selection.relativeEntries === "skip") continue;
    const workingDirectory =
      relativeEntry && selection.relativeEntries === "resolve"
        ? (selection.workingDirectory ?? currentDirectory())
        : undefined;
    // A removed working directory holds nothing; later entries still count.
    if (relativeEntry && workingDirectory === undefined) continue;
    for (const command of typeof commands === "string" ? [commands] : commands)
      yield {
        path: absoluteCallerPath(
          appendCallerPath(directory, command, "linux"),
          {
            ...(workingDirectory === undefined
              ? {}
              : { cwd: workingDirectory }),
            platform: "linux",
          },
        ),
        relativeEntry,
      };
  }
}

/**
 * This process's directory, or `undefined` once it has been removed: a
 * launcher then finds nothing under a relative entry and moves on.
 */
const currentDirectory = (): string | undefined => {
  try {
    return process.cwd();
  } catch (cause: unknown) {
    // A removed directory has no path; the entry names nothing.
    void cause;
    return undefined;
  }
};

/**
 * Windows PATH entries in order. A quote opens only at the start of an entry,
 * and a quoted entry may contain `;`; elsewhere a quote is an ordinary
 * character, so it cannot join later entries. Empty entries, `""` and
 * entries with a stray quote name nothing and are skipped.
 */
const windowsPathEntries = (value: string): readonly string[] => {
  const entries: string[] = [];
  let start = 0;
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '"' && (quoted || index === start)) quoted = !quoted;
    else if (value[index] === ";" && !quoted) {
      entries.push(value.slice(start, index));
      start = index + 1;
    }
  }
  entries.push(value.slice(start));
  return entries.flatMap((entry) => {
    if (entry === "") return [];
    if (entry.startsWith('"') && entry.endsWith('"') && entry.length >= 2)
      return entry.length === 2 ? [] : [entry.slice(1, -1)];
    return entry.includes('"') ? [] : [entry];
  });
};

/** Image extensions Windows starts directly; anything else needs a host such as cmd.exe. */
const WINDOWS_IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([".com", ".exe"]);

/** A rooted path without a drive still depends on the working directory. */
const hasIndependentWindowsRoot = (path: string): boolean =>
  win32.isAbsolute(path) && win32.parse(path).root.length > 1;

/** A PATHEXT entry that is not a filename extension, so the search is unknown. */
export interface WindowsPathSearchFailure {
  readonly kind: "invalid_extension";
  readonly extension: string;
}

/**
 * The files Windows' PATH/PATHEXT search tries for commands, in order: a
 * path-qualified command (`C:\Python\python`, `.venv\Scripts\python`) only at
 * its own location, resolved against `cwd`, and never on PATH; then for each
 * PATH entry (relative ones, including a rooted entry without a drive such as
 * `\tools`, resolve against `cwd`, or against this process's directory, read
 * only when such an entry is reached and skipped once removed; they are
 * marked `relativeEntry`), each bare command with every PATHEXT extension,
 * or as written when it already names an extension. Only `.com` and `.exe`
 * images are searched unless `allowBatch`; a `.bat` or `.cmd` launcher must
 * then be started through src/process/WindowsBatchCommand. An invalid
 * PATHEXT entry fails a search that would append extensions; a command that
 * names its extension never consults PATHEXT. Environment names match without
 * case.
 */
export const windowsPathCandidates = (
  commands: string | readonly string[],
  environment: Readonly<NodeJS.ProcessEnv>,
  search: { readonly cwd?: string; readonly allowBatch?: boolean } = {},
): Result<Iterable<PathSearchCandidate>, WindowsPathSearchFailure> => {
  const selected = snapshotEnvironment(environment, "win32");
  const listed = typeof commands === "string" ? [commands] : commands;
  const extensions = (selected.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter((extension) => extension !== "");
  const invalid = listed.every((command) => win32.extname(command) !== "")
    ? undefined
    : extensions.find(
        (extension) =>
          !extension.startsWith(".") || /[\\/:\0]/u.test(extension),
      );
  if (invalid !== undefined)
    return err({ kind: "invalid_extension", extension: invalid });
  const runnable = (extension: string) =>
    search.allowBatch === true ||
    WINDOWS_IMAGE_EXTENSIONS.has(extension.toLowerCase());
  const spelled = (command: string): string[] => {
    const explicit = win32.extname(command);
    if (explicit !== "") return runnable(explicit) ? [command] : [];
    return extensions
      .filter(runnable)
      .map((extension) => `${command}${extension}`);
  };
  const qualified = (command: string): boolean =>
    /[\\/]/u.test(command) || win32.parse(command).root !== "";
  const located = listed.filter(qualified).flatMap(spelled);
  const names = listed
    .filter((command) => !qualified(command))
    .flatMap(spelled);
  const entries = windowsPathEntries(selected.PATH ?? "");
  return ok({
    *[Symbol.iterator]() {
      for (const name of located) {
        const workingDirectory = hasIndependentWindowsRoot(name)
          ? name
          : (search.cwd ?? currentDirectory());
        if (workingDirectory === undefined) continue;
        yield {
          path: win32.resolve(workingDirectory, name),
          relativeEntry: false,
        };
      }
      if (names.length === 0) return;
      for (const directory of entries) {
        // Only an entry without a drive or UNC root reads the working
        // directory; a removed one holds nothing, and later entries count.
        const relativeEntry = !hasIndependentWindowsRoot(directory);
        const workingDirectory = relativeEntry
          ? (search.cwd ?? currentDirectory())
          : directory;
        if (workingDirectory === undefined) continue;
        for (const name of names)
          yield {
            path: win32.resolve(workingDirectory, directory, name),
            relativeEntry,
          };
      }
    },
  });
};
