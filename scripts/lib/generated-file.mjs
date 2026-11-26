import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const isMissing = (cause) =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  cause.code === "ENOENT";

const normalizeLineEndings = (value) => value.replaceAll("\r\n", "\n");

const preserveLineEndings = (source, existing) =>
  existing?.includes("\r\n") === true
    ? normalizeLineEndings(source).replaceAll("\n", "\r\n")
    : source;

/** Compare or update one generated text artifact with actionable diagnostics. */
export const ensureGeneratedFile = async ({
  path,
  source,
  check,
  generateCommand,
}) => {
  let existing;
  try {
    existing = await readFile(path, "utf8");
  } catch (cause) {
    if (!isMissing(cause)) throw cause;
  }
  if (
    existing !== undefined &&
    normalizeLineEndings(existing) === normalizeLineEndings(source)
  )
    return { changed: false };
  if (check)
    throw new Error(
      `${path} is missing or stale. Run \`${generateCommand}\` to regenerate it; commit the result if the file is tracked.`,
    );
  await writeFile(path, preserveLineEndings(source, existing), "utf8");
  return { changed: true };
};

/** Relative paths in depth-first order, sorting siblings by entry name. */
export async function regularFilePaths(root, invalidEntryMessage) {
  const paths = [];
  async function walk(directory, prefix) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    )) {
      const name = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await walk(join(directory, entry.name), name);
      else if (entry.isFile()) paths.push(name);
      else throw new Error(invalidEntryMessage(name));
    }
  }
  await walk(root, "");
  return paths;
}
