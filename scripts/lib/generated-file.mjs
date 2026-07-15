import { readFile, writeFile } from "node:fs/promises";

const isMissing = (cause) =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  cause.code === "ENOENT";

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
  if (existing === source) return { changed: false };
  if (check)
    throw new Error(
      `${path} is missing or stale. Run \`${generateCommand}\` and commit the result.`,
    );
  await writeFile(path, source, "utf8");
  return { changed: true };
};
