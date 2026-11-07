import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, isAbsolute } from "node:path";

const isExecutable = async (path: string): Promise<boolean> => {
  try {
    await access(path, constants.X_OK);
    // Match access() and the launch: inspect the link's target, not the link.
    return (await stat(path)).isDirectory() === false;
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
  const from = (path: string) =>
    tidy(isAbsolute(path) ? path : `${startedIn}/${path}`);
  if (program.includes("/")) {
    const path = from(program);
    return (await isExecutable(path))
      ? { path, fromRelativeEntry: false }
      : undefined;
  }
  for (const directory of environment.PATH?.split(delimiter) ?? []) {
    const path = from(directory === "" ? program : `${directory}/${program}`);
    if (await isExecutable(path))
      return { path, fromRelativeEntry: !isAbsolute(directory) };
  }
  return undefined;
};
