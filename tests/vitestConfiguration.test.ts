import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { SERIAL_INTEGRATION_TESTS } from "../vitest.config.js";

const execute = promisify(execFile);

describe("Vitest project configuration", () => {
  it("collects exact disjoint parallel and serial test sets", async () => {
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
    const projects = parseProjects(stdout);
    const parallel = projects.get("parallel") ?? [];
    const serial = projects.get("serial-integration") ?? [];
    const repositoryTests = await testFiles("tests");

    expect(serial).toEqual([...SERIAL_INTEGRATION_TESTS].sort());
    expect(parallel.filter((path) => serial.includes(path))).toEqual([]);
    expect([...new Set([...parallel, ...serial])].sort()).toEqual(
      repositoryTests,
    );
  }, 20_000);
});

const parseProjects = (output: string): Map<string, string[]> => {
  const projects = new Map<string, string[]>();
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    const separator = trimmed.indexOf("] ");
    if (!trimmed.startsWith("[") || separator < 2) continue;
    const project = trimmed.slice(1, separator);
    const path = trimmed.slice(separator + 2);
    if (path.length === 0) continue;
    const paths = projects.get(project) ?? [];
    paths.push(path);
    projects.set(project, paths);
  }
  for (const paths of projects.values()) paths.sort();
  return projects;
};

const testFiles = async (root: string): Promise<string[]> => {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await testFiles(path)));
    else if (entry.isFile() && entry.name.endsWith(".test.ts"))
      files.push(path);
  }
  return files.sort();
};
