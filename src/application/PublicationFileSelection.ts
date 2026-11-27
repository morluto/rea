import type { Stats } from "node:fs";
import { lstat } from "node:fs/promises";
import { sameRegularFileState } from "../filesystem/RegularFile.js";
import { isEnoentError } from "./ClientConfigPath.js";

/** Check the selected entry at its name without following a replacement symlink. */
export const publicationPathMatchesSelection = async (
  path: string,
  selected: Stats | undefined,
): Promise<boolean> => {
  let named: Stats;
  try {
    named = await lstat(path);
  } catch (cause: unknown) {
    if (isEnoentError(cause)) return selected === undefined;
    throw cause;
  }
  return (
    selected !== undefined &&
    !named.isSymbolicLink() &&
    sameRegularFileState(selected, named)
  );
};
