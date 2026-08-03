import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import vitestConfiguration, {
  MAX_TEST_WORKERS,
  TEST_PROJECTS,
} from "../../vitest.config.js";

const execute = promisify(execFile);
const EXPECTED_PROJECTS = [
  "acceptance",
  "adapters",
  "boundary",
  "composition",
  "conformance",
  "domain",
  "evaluation",
  "mcp-boundary",
  "process-global",
  "services",
];
const ALLOWED_DIRECT_TEMPORARY_ROOTS = new Set([
  "tests/support/workspace/workspaceFixture.ts",
  "tests/acceptance/setup/packageInstallWorkflow.test.ts",
  "tests/boundary/filesystem/temporaryDirectory.test.ts",
  "tests/boundary/filesystem/referenceSourceReader.test.ts",
  "tests/boundary/process/providerProcess.test.ts",
]);

describe("Vitest project configuration", () => {
  it("keeps deterministic execution retry-free and locally quiet", () => {
    expect(vitestConfiguration.test?.coverage?.enabled).toBe(false);
    expect(vitestConfiguration.test?.reporters).toEqual(["default"]);
    expect(vitestConfiguration.test?.retry).toBe(0);
    expect(MAX_TEST_WORKERS).toBe(Math.min(2, availableParallelism()));
    expect(TEST_PROJECTS.map(({ name }) => name).sort()).toEqual(
      EXPECTED_PROJECTS,
    );
  });

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

  it("keeps direct temporary-root creation behind the workspace seam", async () => {
    const violations: string[] = [];
    for (const path of await repositoryTypeScriptFiles("tests")) {
      const source = await readFile(path, "utf8");
      if (
        /\b(?:mkdtemp|tmpdir)\s*\(/u.test(source) &&
        !ALLOWED_DIRECT_TEMPORARY_ROOTS.has(path)
      ) {
        violations.push(path);
      }
    }
    expect(violations).toEqual([]);
  });
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

const repositoryTypeScriptFiles = async (root: string): Promise<string[]> => {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await repositoryTypeScriptFiles(path)));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(relative(process.cwd(), path));
    }
  }
  return files;
};
