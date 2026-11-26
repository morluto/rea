// Stryker's typescript-checker watches the files the mutation project
// includes. A mutated file that the project does not include has no watcher,
// and the sweep aborts with "no watcher is registered for it" before it can
// report a score. The mutation configs own the target list and this guard
// owns the project that must contain it.
//
// Both lists drift apart when a mutation target moves to a new module and the
// project file is not updated with it. The check therefore reads the resolved
// targets from the configurations themselves instead of from a second copy.

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const MUTATION_CONFIGS = ["stryker.config.mjs", "stryker.semantics.config.mjs"];
const MUTATION_PROJECT = "tsconfig.reverse-tools-mutation.json";

/**
 * The files a mutation configuration mutates.
 * A target is a `path:startLine-endLine` range produced by mutationRanges.
 */
const mutationTargets = async (configName) => {
  const config = (await import(join(root, configName))).default;
  const targets = new Set();
  for (const target of config.mutate) {
    const separator = target.lastIndexOf(":");
    if (separator < 0)
      throw new Error(
        `${configName} has an unreadable mutation target: ${target}`,
      );
    targets.add(target.slice(0, separator));
  }
  return targets;
};

/**
 * A project file that lists a mutation target it does not include.
 * The sweep cannot watch a file the project leaves out.
 */
const uncoveredTarget = (targets, included) =>
  [...targets].filter((target) => !included.has(target)).sort();

/**
 * A project entry that names a file the repository no longer has.
 * A renamed module leaves the old entry behind, and the rename is what lets
 * the two lists drift apart.
 */
const missingProjectEntry = async (included) => {
  const missing = [];
  for (const entry of included) {
    if (entry.includes("*")) continue;
    try {
      await stat(join(root, entry));
    } catch {
      missing.push(entry);
    }
  }
  return missing.sort();
};

const project = JSON.parse(
  await readFile(join(root, MUTATION_PROJECT), "utf8"),
);
const included = new Set(project.include ?? []);

const failures = [];
for (const configName of MUTATION_CONFIGS) {
  const targets = await mutationTargets(configName);
  const uncovered = uncoveredTarget(targets, included);
  if (uncovered.length > 0)
    failures.push(
      `${configName} mutates files that ${MUTATION_PROJECT} does not include:\n${uncovered.map((target) => `  ${target}`).join("\n")}`,
    );
}
const missing = await missingProjectEntry(included);
if (missing.length > 0)
  failures.push(
    `${MUTATION_PROJECT} includes files the repository no longer has:\n${missing.map((entry) => `  ${entry}`).join("\n")}`,
  );

if (failures.length > 0) {
  console.error(`Mutation project guard failed:\n\n${failures.join("\n\n")}\n`);
  process.exit(1);
}
console.log(
  `Mutation project guard passed: ${MUTATION_CONFIGS.length} configuration(s) match ${MUTATION_PROJECT}.`,
);
