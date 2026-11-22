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

/** Candidate spellings in launch order, anchored without reserializing PATH. */
export function* programCandidates(
  program: string,
  environment: Readonly<Record<string, string | undefined>>,
  startedIn: string,
): IterableIterator<FoundProgram> {
  if (program.includes("/")) {
    yield {
      path: absoluteCallerPath(program, { cwd: startedIn }),
      fromRelativeEntry: false,
    };
    return;
  }
  if (environment.PATH === undefined) return;
  for (const candidate of posixPathCandidates(program, environment.PATH, {
    relativeEntries: "resolve",
    workingDirectory: startedIn,
  }))
    yield {
      path: candidate.path,
      fromRelativeEntry: candidate.relativeEntry,
    };
}

/**
 * Inspect availability in the original launch context. This does not establish
 * that execution will succeed: an executable can have a missing interpreter.
 * Callers that launch must retain execution-time PATH fallback themselves.
 */
export const resolveProgram = async (
  program: string,
  environment: Readonly<Record<string, string | undefined>>,
  startedIn: string,
): Promise<FoundProgram | undefined> => {
  for (const candidate of programCandidates(program, environment, startedIn))
    if (await isExecutable(candidate.path)) return candidate;
  return undefined;
};
