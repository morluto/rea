import { statSync } from "node:fs";
import { win32 } from "node:path";
import { windowsPathCandidates } from "../process/executableSearch.js";

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

/** Resolve Windows bare command names against the captured child environment. */
export const resolveWindowsProviderExecutable = (
  executable: string,
  environment: Readonly<NodeJS.ProcessEnv>,
  lookup: WindowsExecutableLookup = {},
): string => {
  const cwd = lookup.cwd ?? process.cwd();
  const absolute = (...paths: string[]): string => win32.resolve(cwd, ...paths);
  if (
    win32.isAbsolute(executable) ||
    executable.includes("/") ||
    executable.includes("\\") ||
    win32.parse(executable).root !== ""
  )
    return absolute(executable);

  const candidates = windowsPathCandidates(executable, environment, { cwd });
  // An unresolved name, or a search an invalid PATHEXT leaves unknown, keeps
  // the bare name as before.
  if (candidates.ok)
    for (const { path } of candidates.value)
      if ((lookup.isFile ?? isRegularFile)(path)) return path;
  return executable;
};
