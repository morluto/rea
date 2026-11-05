import { constants } from "node:fs";
import { access, lstat } from "node:fs/promises";
import { delimiter, isAbsolute } from "node:path";

const isExecutable = async (path: string): Promise<boolean> => {
  try {
    await access(path, constants.X_OK);
    return (await lstat(path)).isDirectory() === false;
  } catch {
    return false;
  }
};

/** A path without empty or `.` segments, which name nothing; `..` stays, since it climbs from a link's target. */
const tidy = (path: string): string =>
  path.replace(/\/(?:\.?\/)+/gu, "/").replace(/(?<=.)\/\.?$/u, "");

/**
 * Find a program the way a shell would, without running a shell: a relative
 * path is read from the directory the program is started in, and so is an
 * empty or relative PATH entry when `searchRelative` is set, as for the PATH
 * an `env` prefix sets, which travels with the launch command; the host's own
 * PATH does not. `..` is kept, so after a symbolic link it means what it
 * means to the launch.
 */
export const resolveProgram = async (
  program: string,
  environment: Readonly<Record<string, string | undefined>>,
  startedIn: string,
  searchRelative: boolean,
): Promise<string | undefined> => {
  const from = (path: string) =>
    tidy(isAbsolute(path) ? path : `${startedIn}/${path}`);
  const candidates = program.includes("/")
    ? [from(program)]
    : (environment.PATH?.split(delimiter) ?? [])
        .filter((directory) => searchRelative || isAbsolute(directory))
        .map((directory) => from(`${directory}/${program}`));
  for (const candidate of candidates)
    if (await isExecutable(candidate)) return candidate;
  return undefined;
};
