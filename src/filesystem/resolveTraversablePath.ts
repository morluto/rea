import { realpath, stat } from "node:fs/promises";

/** Canonicalize only after the operating system accepts the selected spelling. */
export const resolveTraversablePath = async (path: string): Promise<string> => {
  // Darwin realpath can collapse file/.. even though native lookup returns ENOTDIR.
  await stat(path);
  return realpath(path);
};
