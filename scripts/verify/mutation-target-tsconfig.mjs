import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript6";

const rootUrl = new URL("../../", import.meta.url);
const root = fileURLToPath(rootUrl);
const configNames = ["stryker.config.mjs", "stryker.semantics.config.mjs"];
const projectFiles = new Map();
const failures = [];
const diagnosticsHost = {
  getCanonicalFileName: (path) => path,
  getCurrentDirectory: ts.sys.getCurrentDirectory,
  getNewLine: () => ts.sys.newLine,
};

// Stryker's range selectors read source paths relative to the repository.
process.chdir(root);

const fileKey = (path) =>
  ts.sys.useCaseSensitiveFileNames ? path : path.toLowerCase();

for (const configName of configNames) {
  const { default: config } = await import(new URL(configName, rootUrl).href);
  if (typeof config.tsconfigFile !== "string" || !config.tsconfigFile)
    throw new Error(`${configName} must name a TypeScript checker project`);

  const projectPath = resolve(root, config.tsconfigFile);
  const projectName = relative(root, projectPath);
  if (!projectFiles.has(projectPath)) {
    const project = ts.getParsedCommandLineOfConfigFile(
      projectPath,
      {},
      {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
          throw new Error(ts.formatDiagnostic(diagnostic, diagnosticsHost));
        },
      },
    );
    if (project.errors.length > 0)
      throw new Error(ts.formatDiagnostics(project.errors, diagnosticsHost));

    // TypeScript silently drops unmatched include entries. Require literal paths
    // in this project to exist while allowing globs and directory includes.
    for (const entry of project.raw.include ?? []) {
      const path = resolve(dirname(projectPath), entry);
      if (
        !/[*?]/u.test(entry) &&
        !ts.sys.fileExists(path) &&
        !ts.sys.directoryExists(path)
      )
        failures.push(`${projectName} has a missing include entry: ${entry}`);
    }
    projectFiles.set(
      projectPath,
      new Set(project.fileNames.map((path) => fileKey(resolve(path)))),
    );
  }

  // A transitive import can be in the program without a Stryker file watcher.
  // Check the compiler's root file list. Both configs emit concrete line ranges.
  const targets = new Set(
    config.mutate.map((target) => {
      const match = /^(.+):\d+-\d+$/u.exec(target);
      if (!match)
        throw new Error(
          `${configName} has an unreadable mutation target: ${target}`,
        );
      return match[1];
    }),
  );
  const files = projectFiles.get(projectPath);
  for (const target of [...targets].sort()) {
    if (!files.has(fileKey(resolve(root, target))))
      failures.push(
        `${configName} requires ${target} as a root file in ${projectName}`,
      );
  }
}

if (failures.length > 0) {
  console.error(`Mutation project guard failed:\n${failures.join("\n")}\n`);
  process.exitCode = 1;
} else {
  console.log(
    `Mutation project guard passed for ${configNames.length} configurations.`,
  );
}
