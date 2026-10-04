import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execute = promisify(execFile);
describe("Vitest project configuration", () => {
  it("classifies every deterministic test in exactly one project", async () => {
    const { stdout } = await execute(
      process.execPath,
      [
        resolve("node_modules/vitest/vitest.mjs"),
        "list",
        "--filesOnly",
        "--staticParse",
      ],
      { cwd: process.cwd(), maxBuffer: 4 * 1_024 * 1_024 },
    );
    const classified = parseProjects(stdout);
    const repositoryTests = [
      ...(await testFiles("src")),
      ...(await testFiles("tests")),
    ].sort();

    expect(
      [...classified.values()]
        .filter((owners) => owners.length > 1)
        .map((owners) => owners.join(", ")),
    ).toEqual([]);
    expect([...classified.keys()].sort()).toEqual(repositoryTests);
  }, 20_000);
});

const parseProjects = (output: string): Map<string, string[]> => {
  const classified = new Map<string, string[]>();
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    const separator = trimmed.indexOf("] ");
    if (!trimmed.startsWith("[") || separator < 2) continue;
    const project = trimmed.slice(1, separator);
    const path = trimmed.slice(separator + 2);
    if (path.length === 0) continue;
    const owners = classified.get(path) ?? [];
    owners.push(project);
    classified.set(path, owners);
  }
  return classified;
};

const testFiles = async (root: string): Promise<string[]> => {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await testFiles(path)));
    else if (entry.isFile() && entry.name.endsWith(".test.ts"))
      files.push(relative(process.cwd(), path));
  }
  return files;
};
