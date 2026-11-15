import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  readImportSpecifiers,
  readVerifierSourceSpecifiers,
} from "../../scripts/lib/import-specifiers.mjs";
import { packageImportTarget } from "../../scripts/lib/module-boundaries.mjs";
import { typeScriptSourcePath } from "../../scripts/lib/verifier-source-loader.mjs";

const REPOSITORY = fileURLToPath(new URL("../../", import.meta.url));

const PARSED = /\.(?:[cm]?js|[cm]?ts)$/u;

/** The package manifest, build output and installed packages belong to the copy's own setup. */
const NOT_SOURCE = /^(?:(?:dist|node_modules)\/|package\.json$)/u;

const repositoryFile = (root: string, path: string): string => {
  const selected = relative(root, path);
  if (
    selected === "" ||
    selected === ".." ||
    selected.startsWith(`..${sep}`) ||
    isAbsolute(selected)
  )
    throw new Error(`Import target ${path} is outside ${root}`);
  return selected.split(sep).join("/");
};

/** The path one specifier names as Node loads it; `undefined` for a bare package. */
const loadTarget = (
  root: string,
  importer: URL,
  specifier: string,
): string | undefined => {
  if (specifier.startsWith("#")) return packageImportTarget(root, specifier);
  if (specifier.startsWith("file:")) return fileURLToPath(specifier);
  if (isAbsolute(specifier)) return resolve(specifier);
  if (specifier.startsWith("./") || specifier.startsWith("../"))
    return fileURLToPath(new URL(specifier, importer));
  return undefined;
};

/** The file Node, or the verifier source loader, loads for one import target. */
const loadedFile = (root: string, target: string, importer: string): string => {
  const path = resolve(root, target);
  const file = repositoryFile(root, path);
  if (existsSync(path)) return file;
  const source = typeScriptSourcePath(path);
  if (source !== undefined && existsSync(source))
    return repositoryFile(root, source);
  throw new Error(`${importer} imports ${target}, which does not exist`);
};

/**
 * Repository files an isolated copy of `entries` needs at runtime, in visit
 * order: the entries and every own-source module reachable through static or
 * literal dynamic imports and literal `importVerifierSource` loads. Type-only
 * edges are erased at runtime and are not followed. Bare package specifiers,
 * `node_modules/`, build output under `dist/` and the root `package.json` are
 * left to the copy's own setup. Non-literal loads are invisible; pass their targets as entries.
 */
export const scriptImportClosure = async (
  entries: readonly string[],
  root = REPOSITORY,
): Promise<readonly string[]> => {
  const visited = new Set<string>();
  const pending = [...entries];
  for (let file = pending.shift(); file !== undefined; file = pending.shift()) {
    if (visited.has(file)) continue;
    visited.add(file);
    if (!PARSED.test(file)) continue;
    const source = await readFile(join(root, file), "utf8");
    const importer = pathToFileURL(join(root, file));
    const targets = [
      ...readImportSpecifiers(source)
        .filter(({ typeOnly }) => !typeOnly)
        .map(({ specifier }) => loadTarget(root, importer, specifier)),
      ...readVerifierSourceSpecifiers(source).map(({ specifier }) =>
        fileURLToPath(new URL(specifier, importer)),
      ),
    ]
      .filter((target): target is string => target !== undefined)
      .map((target) => repositoryFile(root, target));
    for (const target of targets)
      if (!NOT_SOURCE.test(target))
        pending.push(loadedFile(root, target, file));
  }
  return [...visited];
};

/** Copy `entries` and their runtime import closure to the same paths under `destination`. */
export const copyScriptsWithImports = async (
  entries: readonly string[],
  destination: string,
  root = REPOSITORY,
): Promise<readonly string[]> => {
  const files = await scriptImportClosure(entries, root);
  for (const file of files) {
    await mkdir(dirname(join(destination, file)), { recursive: true });
    await copyFile(join(root, file), join(destination, file));
  }
  return files;
};
