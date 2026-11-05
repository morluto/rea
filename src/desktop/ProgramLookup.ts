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

/**
 * Find a program the way a shell would, without running a shell: a relative
 * path, or an empty or relative PATH entry, is read from the directory the
 * program is started in. Paths are joined, not normalized, so `..` after a
 * symbolic link means what it means to the launch.
 */
export const resolveProgram = async (
  program: string,
  environment: Readonly<Record<string, string | undefined>>,
  startedIn: string,
): Promise<string | undefined> => {
  const from = (path: string) =>
    isAbsolute(path) ? path : `${startedIn}/${path}`;
  const candidates = program.includes("/")
    ? [from(program)]
    : (environment.PATH?.split(delimiter) ?? []).map((directory) =>
        directory === "" || directory === "."
          ? `${startedIn}/${program}`
          : `${from(directory)}/${program}`,
      );
  for (const candidate of candidates)
    if (await isExecutable(candidate)) return candidate;
  return undefined;
};
