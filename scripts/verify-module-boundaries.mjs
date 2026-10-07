import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { inspectModuleBoundaries } from "./lib/module-boundaries.mjs";

const execute = promisify(execFile);
const root = process.cwd();
const selected = process.argv.slice(2);
for (const file of selected)
  if (!file.endsWith(".ts"))
    throw new TypeError(`Expected an exact TypeScript source file: ${file}`);
const files =
  selected.length > 0
    ? selected
    : (
        await execute(
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
        )
      ).stdout.split("\0");

let checked = 0;
for (const file of new Set(files.filter((path) => path.endsWith(".ts")))) {
  let source;
  try {
    source = await readFile(resolve(root, file), "utf8");
  } catch (cause) {
    if (selected.length === 0 && cause.code === "ENOENT") continue;
    throw cause;
  }
  checked += 1;
  try {
    for (const violation of inspectModuleBoundaries(file, source, root)) {
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
if (process.exitCode !== 1)
  console.log(`Checked resolved module boundaries in ${checked} source files.`);
