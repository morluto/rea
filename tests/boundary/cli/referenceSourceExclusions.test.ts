import {
  mkdir,
  readFile,
  readlink,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import { describe, expect } from "vitest";

import { historicalSourceGraphSchema } from "../../../src/domain/referenceSourceGraph.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import type { TestCli } from "../../support/cli/cliFixture.js";

const isolatedEnvironment = (root: string) => ({
  HOME: root,
  USERPROFILE: root,
  XDG_CONFIG_HOME: root,
  XDG_CACHE_HOME: root,
  REA_REFERENCE_SECRET_PATTERNS_JSON: '["private.txt"]',
});

const importSource = (
  cli: TestCli,
  root: string,
  excludePaths: string | undefined,
) =>
  cli.run({
    arguments: [
      "import-reference-source",
      root,
      "--json",
      ...(excludePaths === undefined ? [] : ["--exclude-paths", excludePaths]),
    ],
    cwd: root,
    environment: isolatedEnvironment(root),
  });

describe.skipIf(process.platform === "win32")(
  "compiled reference-source exclusion provenance",
  () => {
    cliTest(
      "imports source beside a link into a default-excluded directory",
      async ({ cli }) => {
        const root = await createTestTempDirectory(
          "rea-reference-link-exclusion-",
        );
        await mkdir(join(root, "dist"));
        const source = "export const value = 1;\n";
        await writeFile(join(root, "source.ts"), source);
        await symlink("dist", join(root, "alias"));
        const result = await cli.run({
          arguments: ["import-reference-source", root, "--json"],
          cwd: root,
          environment: {
            HOME: root,
            USERPROFILE: root,
            XDG_CONFIG_HOME: root,
            XDG_CACHE_HOME: root,
          },
        });
        expect(result.exitCode).toBe(0);
        const graph = historicalSourceGraphSchema.parse(result.json);
        expect(graph.inventory_state).toBe("partial");
        expect(graph.exclusions).toContainEqual({
          path: "dist",
          entry_kind: "directory",
          reason: "default-ignored",
          pattern: "dist/",
        });
        expect(graph.entries).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              path: "alias",
              kind: "symlink",
              target: "dist",
              target_state: "internal",
            }),
            expect.objectContaining({
              path: "source.ts",
              kind: "file",
              content_state: "hashed",
            }),
          ]),
        );
        expect(graph.entries.some(({ path }) => path === "dist")).toBe(false);
        expect(await readFile(join(root, "source.ts"), "utf8")).toBe(source);
        expect(await readlink(join(root, "alias"))).toBe("dist");
      },
    );

    cliTest(
      "reports project, default, and explicit secret exclusions",
      async ({ cli }) => {
        const root = await createTestTempDirectory("rea-reference-exclusions-");
        const logs = join(root, "logs");
        await mkdir(logs);
        await Promise.all([
          writeFile(join(root, ".gitignore"), "project.tmp\n"),
          writeFile(join(root, "project.tmp"), "project policy\n"),
          writeFile(join(logs, "application.log"), "default policy\n"),
          writeFile(join(root, "private.txt"), "sensitive local file\n"),
          writeFile(join(root, "source.ts"), "export const value = 1;\n"),
        ]);

        const result = await cli.run({
          arguments: ["import-reference-source", root, "--json"],
          cwd: root,
          environment: {
            HOME: root,
            USERPROFILE: root,
            XDG_CONFIG_HOME: root,
            XDG_CACHE_HOME: root,
            REA_REFERENCE_SECRET_PATTERNS_JSON: '["private.txt"]',
          },
        });

        expect(result.exitCode).toBe(0);
        const graph = historicalSourceGraphSchema.parse(result.json);
        expect(graph.exclusions).toEqual(
          expect.arrayContaining([
            {
              path: "project.tmp",
              entry_kind: "file",
              reason: "project-ignored",
              pattern: "project.tmp",
            },
            {
              path: "logs/application.log",
              entry_kind: "file",
              reason: "default-ignored",
              pattern: "*.log",
            },
            {
              path: "private.txt",
              entry_kind: "file",
              reason: "configured-secret",
              pattern: "private.txt",
            },
          ]),
        );
        expect(graph.entries).toContainEqual(
          expect.objectContaining({ path: "source.ts", kind: "file" }),
        );
      },
    );
  },
);

describe.skipIf(process.platform === "win32")(
  "compiled reference-source caller exclusions",
  () => {
    cliTest(
      "prunes caller-excluded directories and applies Git-ignore rules",
      async ({ cli }) => {
        const root = await createTestTempDirectory(
          "rea-reference-caller-exclusions-",
        );
        const logs = join(root, "logs");
        const skipped = join(root, "skip-me", "nested");
        await mkdir(logs);
        await mkdir(skipped, { recursive: true });
        await Promise.all([
          writeFile(join(root, ".gitignore"), "project.tmp\n"),
          writeFile(join(root, "project.tmp"), "project policy\n"),
          writeFile(join(logs, "application.log"), "default policy\n"),
          writeFile(join(root, "keep.log"), "negated default rule\n"),
          writeFile(join(root, "private.txt"), "sensitive local file\n"),
          writeFile(join(root, "notes.tmp"), "caller wildcard\n"),
          writeFile(join(skipped, "hidden.ts"), "must not be traversed\n"),
          writeFile(join(root, "source.ts"), "export const value = 1;\n"),
        ]);
        const callerRules = '["skip-me/","*.tmp","!keep.log","private.txt"]';

        const omitted = await importSource(cli, root, undefined);
        const empty = await importSource(cli, root, "[]");
        const selected = await importSource(cli, root, callerRules);

        expect(omitted.exitCode).toBe(0);
        expect(empty.exitCode).toBe(0);
        const omittedGraph = historicalSourceGraphSchema.parse(omitted.json);
        const emptyGraph = historicalSourceGraphSchema.parse(empty.json);
        expect(emptyGraph.exclusions).toEqual(omittedGraph.exclusions);
        expect(emptyGraph.entries.map((entry) => entry.path)).toEqual(
          omittedGraph.entries.map((entry) => entry.path),
        );
        expect(omittedGraph.exclusions).not.toContainEqual(
          expect.objectContaining({ reason: "caller-excluded" }),
        );
        expect(omittedGraph.entries).toContainEqual(
          expect.objectContaining({ path: "notes.tmp", kind: "file" }),
        );
        expect(omittedGraph.entries).toContainEqual(
          expect.objectContaining({
            path: "skip-me/nested/hidden.ts",
            kind: "file",
          }),
        );
        expect(omittedGraph.exclusions).toContainEqual({
          path: "keep.log",
          reason: "default-ignored",
          pattern: "*.log",
        });

        expect(selected.exitCode).toBe(0);
        const selectedGraph = historicalSourceGraphSchema.parse(selected.json);
        expect(selectedGraph.exclusions).toEqual([
          {
            path: "logs/application.log",
            reason: "default-ignored",
            pattern: "*.log",
          },
          {
            path: "notes.tmp",
            reason: "caller-excluded",
            pattern: "*.tmp",
          },
          {
            path: "private.txt",
            reason: "configured-secret",
            pattern: "private.txt",
          },
          {
            path: "project.tmp",
            reason: "project-ignored",
            pattern: "project.tmp",
          },
          {
            path: "skip-me",
            reason: "caller-excluded",
            pattern: "skip-me/",
          },
        ]);
        expect(selectedGraph.entries).toContainEqual(
          expect.objectContaining({ path: "source.ts", kind: "file" }),
        );
        expect(selectedGraph.entries).toContainEqual(
          expect.objectContaining({ path: "keep.log", kind: "file" }),
        );
        for (const path of [
          "skip-me",
          "skip-me/nested",
          "skip-me/nested/hidden.ts",
          "notes.tmp",
        ])
          expect(
            selectedGraph.entries.some((entry) => entry.path === path),
            path,
          ).toBe(false);
        expect(
          selectedGraph.exclusions.some((exclusion) =>
            exclusion.path.startsWith("skip-me/"),
          ),
        ).toBe(false);
      },
    );
  },
);

describe("compiled reference-source caller exclusion input", () => {
  for (const scenario of [
    {
      label: "malformed JSON",
      value: "[",
      issue: {
        path: ["excludePaths"],
        reason: "invalid_format",
        expected: "JSON",
      },
    },
    {
      label: "a non-array JSON value",
      value: "{}",
      issue: {
        path: ["excludePaths"],
        reason: "invalid_type",
        expected: "array",
      },
    },
    {
      label: "a numeric rule",
      value: "[1]",
      issue: {
        path: ["excludePaths", 0],
        reason: "invalid_type",
        expected: "string",
      },
    },
    {
      label: "a null rule",
      value: "[null]",
      issue: {
        path: ["excludePaths", 0],
        reason: "invalid_type",
        expected: "string",
      },
    },
    {
      label: "an object rule",
      value: "[{}]",
      issue: {
        path: ["excludePaths", 0],
        reason: "invalid_type",
        expected: "string",
      },
    },
    {
      label: "a boolean rule",
      value: "[true]",
      issue: {
        path: ["excludePaths", 0],
        reason: "invalid_type",
        expected: "string",
      },
    },
    {
      label: "an empty-string rule",
      value: '[""]',
      issue: {
        path: ["excludePaths", 0],
        reason: "out_of_range",
        minimum: 1,
      },
    },
  ]) {
    cliTest(
      `rejects ${scenario.label} before an import starts`,
      async ({ cli }) => {
        const directory = await createTestTempDirectory(
          "rea-reference-exclude-input-",
        );
        const root = join(directory, "missing-source");
        const result = await cli.run({
          arguments: [
            "import-reference-source",
            root,
            "--exclude-paths",
            scenario.value,
            "--json",
          ],
          cwd: directory,
          environment: {
            HOME: directory,
            USERPROFILE: directory,
            XDG_CONFIG_HOME: directory,
            XDG_CACHE_HOME: directory,
          },
        });

        expect(result.exitCode).toBe(1);
        expect(result.json).toMatchObject({
          error: "Import failed",
          code: "invalid_request",
          category: "invalid_input",
          message: expect.stringContaining("Git-ignore"),
          details: {
            operation: "import-reference-source",
            issues: [scenario.issue],
          },
        });
        expect(JSON.stringify(result.json)).not.toContain(
          "could not be resolved",
        );
        expect(JSON.stringify(result.json)).not.toContain(root);
      },
    );
  }

  cliTest(
    "starts an import after an empty exclusion array",
    async ({ cli }) => {
      const directory = await createTestTempDirectory(
        "rea-reference-exclude-empty-",
      );
      const root = join(directory, "missing-source");
      const result = await cli.run({
        arguments: [
          "import-reference-source",
          root,
          "--exclude-paths",
          "[]",
          "--json",
        ],
        cwd: directory,
        environment: {
          HOME: directory,
          USERPROFILE: directory,
          XDG_CONFIG_HOME: directory,
          XDG_CACHE_HOME: directory,
        },
      });

      expect(result.exitCode).toBe(1);
      expect(result.json).toMatchObject({
        error: "Import failed",
        category: "invalid_input",
        message: expect.stringContaining(
          "Reference source root could not be resolved",
        ),
      });
    },
  );
});
