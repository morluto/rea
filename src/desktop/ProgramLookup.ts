import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, isAbsolute } from "node:path";

const isExecutable = async (path: string): Promise<boolean> => {
  try {
    await access(path, constants.X_OK);
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
};

/** A path without empty or `.` segments, which name nothing; `..` stays, since it climbs from a link's target. */
const tidy = (path: string): string =>
  path.replace(/\/(?:\.?\/)+/gu, "/").replace(/(?<=.)\/\.?$/u, "");

/** A program as found, and whether a relative or empty PATH entry found it. */
export interface FoundProgram {
  readonly path: string;
  readonly fromRelativeEntry: boolean;
}

/** Candidate spellings in launch order, anchored without reserializing PATH. */
export function* programCandidates(
  program: string,
  environment: Readonly<Record<string, string | undefined>>,
  startedIn: string,
): IterableIterator<FoundProgram> {
  const from = (path: string) =>
    tidy(isAbsolute(path) ? path : `${startedIn}/${path}`);
  if (program.includes("/")) {
    yield { path: from(program), fromRelativeEntry: false };
    return;
  }
  for (const directory of environment.PATH?.split(delimiter) ?? [])
    yield {
      path: from(directory === "" ? program : `${directory}/${program}`),
      fromRelativeEntry: !isAbsolute(directory),
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
