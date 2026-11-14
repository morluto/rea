import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import {
  inspectResolvedModuleBoundaries,
  resolveModuleImports,
} from "./lib/module-boundaries.mjs";
import { compareLayerBaseline, layerGraphFacts } from "./lib/module-layers.mjs";

const execute = promisify(execFile);
const root = process.cwd();
const printLayerBaseline = process.argv.includes("--print-layer-baseline");
const selected = process.argv
  .slice(2)
  .filter((argument) => argument !== "--print-layer-baseline");
for (const file of selected)
  if (!file.endsWith(".ts"))
    throw new TypeError(`Expected an exact TypeScript source file: ${file}`);

const enumerateSourceFiles = async () => {
  if (selected.length > 0) return selected;
  let isGitRoot = false;
  try {
    const { stdout } = await execute("git", ["rev-parse", "--show-cdup"], {
      cwd: root,
      maxBuffer: 8 * 1024 * 1024,
    });
    isGitRoot = stdout.trim() === "";
  } catch {
    // Archives and source snapshots may not be in a Git worktree.
  }
  if (isGitRoot) {
    try {
      const { stdout } = await execute(
        "git",
        [
          "ls-files",
          "-z",
          "--cached",
          "--others",
          "--exclude-standard",
          "--",
          "src",
        ],
        { cwd: root, maxBuffer: 8 * 1024 * 1024 },
      );
      return stdout.split("\0");
    } catch {
      // Fall back to disk when Git's index is unavailable or unreadable.
    }
  }
  const entries = await readdir(resolve(root, "src"), { recursive: true });
  return entries.map((entry) => join("src", entry));
};

const files = await enumerateSourceFiles();

let checked = 0;
const resolvedImports = [];
for (const file of new Set(files.filter((path) => path.endsWith(".ts")))) {
  let source;
  try {
    source = await readFile(resolve(root, file), "utf8");
  } catch (cause) {
    if (
      selected.length === 0 &&
      (cause.code === "ENOENT" || cause.code === "EISDIR")
    )
      continue;
    throw cause;
  }
  checked += 1;
  try {
    const imports = resolveModuleImports(file, source, root);
    resolvedImports.push(...imports);
    for (const violation of inspectResolvedModuleBoundaries(imports)) {
      console.error(
        `${violation.file}:${violation.line}: ${violation.boundary}: ${violation.specifier} resolves to ${violation.target}`,
      );
      process.exitCode = 1;
    }
  } catch (cause) {
    console.error(`Could not inspect ${file}: ${cause.message}`);
    process.exitCode = 1;
  }
}
// Unit layering and cycles are whole-graph facts; a file selection cannot
// establish them.
if (selected.length === 0) {
  const baselinePath = resolve(root, "scripts/lib/module-layers.baseline.json");
  const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
  const facts = layerGraphFacts(resolvedImports);
  if (printLayerBaseline) {
    console.log(
      JSON.stringify({ upward: facts.upward, cycles: facts.cycles }, null, 2),
    );
  }
  const { failures, lowerable } = compareLayerBaseline(facts, baseline);
  for (const failure of failures) {
    console.error(`module layers: ${failure}`);
    process.exitCode = 1;
  }
  if (lowerable.length > 0)
    console.log(
      `Module layer baseline can be lowered in scripts/lib/module-layers.baseline.json:\n  ${lowerable.join("\n  ")}`,
    );
}
if (process.exitCode !== 1)
  console.log(`Checked resolved module boundaries in ${checked} source files.`);
