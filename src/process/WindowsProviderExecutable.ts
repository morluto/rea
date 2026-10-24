import { existsSync, statSync } from "node:fs";
import { win32 } from "node:path";

export interface WindowsExecutableLookup {
  /** Windows-formatted working directory; defaults to the process CWD. */
  readonly cwd?: string;
  /** Test seam for Windows paths when running on a non-Windows host. */
  readonly isFile?: (path: string) => boolean;
}

const splitWindowsPath = (value: string): readonly string[] => {
  const entries: string[] = [];
  let start = 0;
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '"') quoted = !quoted;
    else if (value[index] === ";" && !quoted) {
      entries.push(value.slice(start, index));
      start = index + 1;
    }
  }
  entries.push(value.slice(start));
  return entries.flatMap((entry) => {
    if (entry.startsWith('"') && entry.endsWith('"') && entry.length >= 2)
      return [entry.slice(1, -1)];
    return entry.includes('"') ? [] : [entry];
  });
};

const isRegularFile = (path: string): boolean => {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
};

/**
 * Resolve Windows bare command names against the captured child environment.
 * The native Windows owned-process launcher starts a drive-path executable
 * directly, so every provider that launches through it must resolve first.
 */
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

  const pathValue = environment.PATH ?? environment.Path ?? environment.path;
  if (pathValue === undefined) return executable;
  const pathEntries = splitWindowsPath(pathValue);
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

  for (const entry of pathEntries) {
    if (entry.length === 0) continue;
    for (const extension of extensions) {
      const candidate = absolute(entry, `${executable}${extension}`);
      if ((lookup.isFile ?? isRegularFile)(candidate)) return candidate;
    }
  }
  return executable;
};
