import { statSync } from "node:fs";
import { win32 } from "node:path";
import { err, ok, type Result } from "../domain/result.js";
import {
  windowsPathCandidates,
  type WindowsPathSearchFailure,
} from "../process/executableSearch.js";

export interface WindowsExecutableLookup {
  /** Windows-formatted working directory; defaults to the process CWD. */
  readonly cwd?: string;
  /** Test seam for Windows paths when running on a non-Windows host. */
  readonly isFile?: (path: string) => boolean;
}

const isRegularFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/**
 * Resolve a configured command against the captured child environment. A
 * path is resolved against `cwd`; a bare name must be found on PATH/PATHEXT,
 * and is never returned unresolved, because Windows would then also search
 * the current directory.
 */
export const resolveWindowsProviderExecutable = (
  executable: string,
  environment: Readonly<NodeJS.ProcessEnv>,
  lookup: WindowsExecutableLookup = {},
): Result<
  string,
  { readonly kind: "not_found" } | WindowsPathSearchFailure
> => {
  const cwd = lookup.cwd ?? process.cwd();
  if (
    win32.isAbsolute(executable) ||
    executable.includes("/") ||
    executable.includes("\\") ||
    win32.parse(executable).root !== ""
  )
    return ok(win32.resolve(cwd, executable));

  const candidates = windowsPathCandidates(executable, environment, { cwd });
  if (!candidates.ok) return candidates;
  for (const { path } of candidates.value)
    if ((lookup.isFile ?? isRegularFile)(path)) return ok(path);
  return err({ kind: "not_found" });
};

/**
 * Resolve a caller-selected provider executable for the spawning platform.
 * Windows requires an absolute executable path, so bare names are resolved
 * against the environment the child will inherit; other platforms spawn the
 * configured value unchanged and let the OS search `PATH`.
 */
export const resolveProviderExecutable = (
  executable: string,
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform,
): string => {
  if (platform !== "win32") return executable;
  const resolved = resolveWindowsProviderExecutable(executable, environment);
  return resolved.ok ? resolved.value : executable;
};
