import { realpath } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import { fileURLToPath } from "node:url";

/** Canonicalize operator roots before evaluating any Electron file target. */
export const canonicalElectronRoots = async (
  roots: readonly string[],
): Promise<readonly string[]> => {
  const canonical: string[] = [];
  for (const root of roots) canonical.push(await realpath(root));
  return [...new Set(canonical)].sort();
};

/** Resolve one file URL and reject host, encoding, and symlink root escapes. */
export const authorizedElectronFile = async (
  value: string,
  roots: readonly string[],
): Promise<string | undefined> => {
  if (value.length > 65_536 || /%(?:2f|5c)/iu.test(value)) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== "file:" ||
    url.hostname !== "" ||
    url.username !== "" ||
    url.password !== ""
  )
    return undefined;
  let path: string;
  try {
    path = fileURLToPath(url);
  } catch {
    return undefined;
  }
  if (!isAbsolute(path) || path.includes("\0")) return undefined;
  let canonical: string;
  try {
    canonical = await realpath(path);
  } catch {
    return undefined;
  }
  return roots.some((root) => withinRoot(root, canonical))
    ? canonical
    : undefined;
};

const withinRoot = (root: string, path: string): boolean => {
  const remainder = relative(root, path);
  return (
    remainder === "" || (!remainder.startsWith("..") && !isAbsolute(remainder))
  );
};
