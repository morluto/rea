import { stat } from "node:fs/promises";
import { win32 } from "node:path";
import { windowsPathEntries } from "../process/WindowsExecutable.js";

import { ProviderStartupDeadline } from "../process/ProviderDeadline.js";
import { ABORTED, waitForAbortable } from "../process/AbortablePromise.js";

export interface WindowsExecutableLookup {
  /** Windows-formatted working directory; defaults to the process CWD. */
  readonly cwd?: string;
  /** Test seam for Windows paths when running on a non-Windows host. */
  readonly isFile?: (path: string) => boolean | Promise<boolean>;
  readonly signal?: AbortSignal | undefined;
  /** Total startup lookup budget, including stalled network filesystem probes. */
  readonly timeoutMs?: number;
}

/**
 * `\\server\share\...` and `//server/share/...` are UNC roots. A single
 * leading separator is drive- or root-relative, and four leading separators
 * are malformed rather than UNC, so neither may take this branch.
 */
const isUncPath = (value: string): boolean => /^[\\/]{2}(?![\\/])/u.test(value);

const isRegularFile = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
};

/** Resolve against every selected PATH entry within a cancellable startup budget. */
export const resolveWindowsProviderExecutable = async (
  executable: string,
  environment: Readonly<NodeJS.ProcessEnv>,
  lookup: WindowsExecutableLookup = {},
): Promise<string> => {
  lookup.signal?.throwIfAborted();
  const cwd = lookup.cwd ?? process.cwd();
  const absolute = (...paths: string[]): string => win32.resolve(cwd, ...paths);
  // A UNC selection is already absolute. Return it verbatim instead of
  // re-rooting it against the process drive through win32.resolve(cwd, ...).
  if (isUncPath(executable)) return executable;
  if (
    win32.isAbsolute(executable) ||
    executable.includes("/") ||
    executable.includes("\\") ||
    win32.parse(executable).root !== ""
  )
    return absolute(executable);

  const pathValue = environment.PATH ?? environment.Path ?? environment.path;
  if (pathValue === undefined) return executable;
  const pathEntries = windowsPathEntries(pathValue);
  const explicitExtension = win32.extname(executable).toLowerCase();
  if (explicitExtension !== "" && ![".com", ".exe"].includes(explicitExtension))
    return executable;
  const extensions =
    explicitExtension !== ""
      ? [""]
      : (environment.PATHEXT ?? environment.PathExt ?? ".COM;.EXE")
          .split(";")
          .filter((extension) =>
            [".com", ".exe"].includes(extension.toLowerCase()),
          );

  const isFile = lookup.isFile ?? isRegularFile;
  const deadline = new ProviderStartupDeadline(
    lookup.timeoutMs ?? 120_000,
    lookup.signal,
  );
  try {
    for (const entry of pathEntries) {
      if (entry.length === 0) continue;
      for (const extension of extensions) {
        deadline.signal.throwIfAborted();
        const candidate = isUncPath(entry)
          ? win32.join(entry, `${executable}${extension}`)
          : absolute(entry, `${executable}${extension}`);
        // Keep a handler on a late filesystem rejection after cancellation.
        const found = await waitForAbortable(
          Promise.resolve(isFile(candidate)),
          deadline.signal,
        );
        if (found === ABORTED) deadline.signal.throwIfAborted();
        if (found) return candidate;
      }
    }
    return executable;
  } catch (cause) {
    if (deadline.interruption === "timeout")
      throw Object.assign(
        new Error(
          "Provider PATH lookup timed out; set an absolute REA_OBJDUMP_COMMAND or REA_RIZIN_COMMAND path.",
          { cause },
        ),
        {
          code: "ETIMEDOUT",
          providerStage: "path_lookup",
          timeoutMs: deadline.timeoutMs,
        },
      );
    throw cause;
  } finally {
    deadline.dispose();
  }
};
