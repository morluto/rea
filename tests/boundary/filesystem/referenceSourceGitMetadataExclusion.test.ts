import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import ignore from "ignore";
import { describe, expect, it } from "vitest";
import { DEFAULT_REFERENCE_SOURCE_IGNORE_PATTERNS } from "../../../src/application/ReferenceSourceImportTypes.js";
import { createHistoricalSourceManifest } from "../../../src/domain/referenceSourceGraph.js";
import { execFileOutput } from "../../../src/process/ExecFileOutput.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { importReferenceSource } from "../../support/referenceSourceResourceScope.js";

const importTree = async (
  root: string,
  secretPatterns: readonly string[] = [],
  excludePaths: readonly string[] = [],
) => {
  const result = await importReferenceSource({
    root,
    caller: "git-metadata-test",
    policy: { secretPatterns },
    excludePaths,
  });
  if (!result.ok) throw result.error;
  return result.value;
};

const fixtureGit = (
  directory: string,
  configuration: string,
  args: readonly string[],
) =>
  execFileOutput(
    "git",
    ["-c", `core.hooksPath=${join(configuration, "no-hooks")}`, ...args],
    {
      cwd: directory,
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            ([name]) => !name.toUpperCase().startsWith("GIT_"),
          ),
        ),
        GIT_CONFIG_GLOBAL: join(configuration, "gitconfig"),
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TEMPLATE_DIR: join(configuration, "no-template"),
      },
    },
  );

it("excludes Git metadata files and directories without broadening directory-only defaults", () => {
  const matcher = ignore().add([...DEFAULT_REFERENCE_SOURCE_IGNORE_PATTERNS]);
  for (const path of [".git", ".git/", "nested/.git", "nested/.git/"])
    expect(matcher.ignores(path), path).toBe(true);
  for (const path of [".gitignore", ".github", ".gitkeep", "dist"])
    expect(matcher.ignores(path), path).toBe(false);
  expect(matcher.ignores("dist/")).toBe(true);
  expect(matcher.test(".git").rule?.pattern).toBe(".git");
  expect(matcher.test(".git/").rule?.pattern).toBe(".git/");
});

describe.skipIf(process.platform === "win32")(
  "reference source Git metadata exclusions",
  () => {
    it("keeps linked-worktree identities stable while retaining HEAD and ordinary-checkout provenance", async () => {
      const root = await createTestTempDirectory("rea-reference-git-metadata-");
      const repository = join(root, "repository");
      await Promise.all([
        mkdir(join(root, "no-hooks")),
        mkdir(join(root, "no-template")),
        writeFile(join(root, "gitconfig"), ""),
      ]);
      await mkdir(join(repository, "src"), { recursive: true });
      await writeFile(
        join(repository, "src", "main.js"),
        "export const value = 7;\n",
      );
      await writeFile(join(repository, ".gitignore"), "*.log\n");
      const git = (...args: string[]) => fixtureGit(repository, root, args);
      await git("init", "--initial-branch=main");
      await git("add", ".gitignore", "src/main.js");
      await git(
        "-c",
        "user.name=REA fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-m",
        "fixture",
      );
      const head = (await git("rev-parse", "HEAD")).stdout.trim();
      const leftRoot = join(root, "left");
      const rightRoot = join(root, "right");
      for (const worktree of [leftRoot, rightRoot]) {
        await git("worktree", "add", "--detach", worktree, head);
        expect(
          (await fixtureGit(worktree, root, ["status", "--porcelain"])).stdout,
        ).toBe("");
      }
      expect(await readFile(join(leftRoot, ".git"), "utf8")).not.toBe(
        await readFile(join(rightRoot, ".git"), "utf8"),
      );
      const importSelectedTree = async (source: string) => {
        const graph = await importTree(source);
        expect(graph.vcs).toEqual({ kind: "git", head, dirty: null });
        expect(
          graph.entries
            .filter(({ kind }) => kind === "file")
            .map(({ path }) => path),
        ).toEqual([".gitignore", "src/main.js"]);
        expect(
          graph.entries.some(
            ({ path }) => path === ".git" || path.startsWith(".git/"),
          ),
        ).toBe(false);
        return graph;
      };
      const left = await importSelectedTree(leftRoot);
      const right = await importSelectedTree(rightRoot);
      const repeated = await importSelectedTree(leftRoot);
      expect(createHistoricalSourceManifest(left)).toEqual(
        createHistoricalSourceManifest(right),
      );
      expect(createHistoricalSourceManifest(repeated)).toEqual(
        createHistoricalSourceManifest(left),
      );
      for (const graph of [left, right])
        expect(graph.exclusions).toEqual([
          {
            path: ".git",
            entry_kind: "file",
            reason: "default-ignored",
            pattern: ".git",
          },
        ]);
      const ordinary = await importSelectedTree(repository);
      expect(ordinary.exclusions).toEqual([
        {
          path: ".git",
          entry_kind: "directory",
          reason: "default-ignored",
          pattern: ".git/",
        },
      ]);
    });

    it.each(["file", "directory"] as const)(
      "prunes nested .git %s metadata and preserves configured-secret precedence",
      async (kind) => {
        const root = await createTestTempDirectory("rea-reference-nested-git-");
        const nested = join(root, "nested");
        await mkdir(nested);
        if (kind === "file")
          await writeFile(
            join(nested, ".git"),
            "gitdir: /checkout-specific/metadata\n",
          );
        else {
          await mkdir(join(nested, ".git", "hooks"), { recursive: true });
          await writeFile(
            join(nested, ".git", "hooks", "pre-commit"),
            "metadata\n",
          );
        }
        for (const name of [
          ".gitignore",
          ".github",
          ".gitkeep",
          "dist",
          "source.js",
        ])
          await writeFile(join(nested, name), "");
        for (const secretPatterns of [[], [".git"]]) {
          const graph = await importTree(
            root,
            secretPatterns,
            secretPatterns.length === 0 ? [] : ["!.git"],
          );
          expect(graph.exclusions).toEqual([
            {
              path: "nested/.git",
              entry_kind: kind,
              reason:
                secretPatterns.length === 0
                  ? "default-ignored"
                  : "configured-secret",
              pattern:
                secretPatterns.length === 0 && kind === "directory"
                  ? ".git/"
                  : ".git",
            },
          ]);
          expect(
            graph.entries
              .filter(({ kind }) => kind === "file")
              .map(({ path }) => path),
          ).toEqual([
            "nested/.github",
            "nested/.gitignore",
            "nested/.gitkeep",
            "nested/dist",
            "nested/source.js",
          ]);
        }
      },
    );
  },
);
