import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";

import { absoluteCallerPath } from "../filesystem/callerPath.js";
import { posixPathCandidates } from "../process/executableSearch.js";
import type { FoundProgram } from "../ports/DesktopApplicationSession.js";

const isExecutable = async (path: string): Promise<boolean> => {
  try {
    await access(path, constants.X_OK);
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
};

/**
 * Find a program as the launch will, without running a shell: a relative path,
 * or an empty or relative PATH entry, is read from the directory the program
 * is started in, in PATH order. `..` is kept, so after a symbolic link it
 * means what it means to the launch.
 */
export const resolveProgram = async (
  program: string,
  environment: Readonly<Record<string, string | undefined>>,
  startedIn: string,
): Promise<FoundProgram | undefined> => {
  if (program.includes("/")) {
    const path = absoluteCallerPath(program, { cwd: startedIn });
    return (await isExecutable(path))
      ? { path, fromRelativeEntry: false }
      : undefined;
  }
  if (environment.PATH === undefined) return undefined;
  for (const candidate of posixPathCandidates(program, environment.PATH, {
    relativeEntries: "resolve",
    workingDirectory: startedIn,
  }))
    if (await isExecutable(candidate.path))
      return {
        path: candidate.path,
        fromRelativeEntry: candidate.relativeEntry,
      };
  return undefined;
};
