import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const CACHE_DIRECTORY = ["node_modules", ".cache"];
const BUILD_INFO_NAME = "rea-tsconfig-build.tsbuildinfo";
const MANIFEST_NAME = "rea-tsconfig-build-outputs.json";

const isMissing = (cause) =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  cause.code === "ENOENT";

const outputFiles = async (root) => {
  const sourceRoot = join(root, "src");
  const entries = await readdir(sourceRoot, { recursive: true });
  return entries
    .filter((entry) => entry.endsWith(".ts") && !entry.endsWith(".d.ts"))
    .sort()
    .map((entry) => {
      const output = `${entry.slice(0, -3)}.js`;
      return { output, path: join(root, "dist", output) };
    });
};

const digest = async (path) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");

const cachePath = (root, name) => join(root, ...CACHE_DIRECTORY, name);

const invalidate = async (root) => {
  await Promise.all([
    rm(cachePath(root, BUILD_INFO_NAME), { force: true }),
    rm(cachePath(root, MANIFEST_NAME), { force: true }),
  ]);
};

const readManifest = async (root) => {
  try {
    const parsed = JSON.parse(
      await readFile(cachePath(root, MANIFEST_NAME), "utf8"),
    );
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      parsed.version !== 1 ||
      typeof parsed.outputs !== "object" ||
      parsed.outputs === null ||
      Array.isArray(parsed.outputs)
    )
      return undefined;
    return parsed.outputs;
  } catch (cause) {
    if (isMissing(cause) || cause instanceof SyntaxError) return undefined;
    throw cause;
  }
};

/** Invalidates incremental state when generated JavaScript was removed or changed. */
export const validateBuildCache = async (root) => {
  const [files, manifest] = await Promise.all([
    outputFiles(root),
    readManifest(root),
  ]);
  if (manifest === undefined || Object.keys(manifest).length !== files.length) {
    await invalidate(root);
    return;
  }
  const matches = await Promise.all(
    files.map(async ({ output, path }) => {
      if (typeof manifest[output] !== "string") return false;
      try {
        return (await digest(path)) === manifest[output];
      } catch (cause) {
        if (isMissing(cause)) return false;
        throw cause;
      }
    }),
  );
  if (!matches.every(Boolean)) await invalidate(root);
};

/** Records generated JavaScript so a later incremental build can verify its cache. */
export const recordBuildCache = async (root) => {
  const files = await outputFiles(root);
  const entries = await Promise.all(
    files.map(async ({ output, path }) => [output, await digest(path)]),
  );
  const source = `${JSON.stringify({ version: 1, outputs: Object.fromEntries(entries) })}\n`;
  const directory = join(root, ...CACHE_DIRECTORY);
  await mkdir(directory, { recursive: true });
  const path = cachePath(root, MANIFEST_NAME);
  let existing;
  try {
    existing = await readFile(path, "utf8");
  } catch (cause) {
    if (!isMissing(cause)) throw cause;
  }
  if (existing !== source) await writeFile(path, source, "utf8");
};
