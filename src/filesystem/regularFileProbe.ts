import { accessSync, constants, statSync } from "node:fs";

/** Best-effort discovery follows symlinks and skips paths it cannot inspect. */
export const isRegularFileSync = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/** POSIX command discovery also requires execute permission on the candidate. */
export const isExecutableFileSync = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK);
  } catch {
    return false;
  }
  return isRegularFileSync(path);
};
