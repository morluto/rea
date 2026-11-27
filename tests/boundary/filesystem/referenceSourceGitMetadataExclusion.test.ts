import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { prepareReferenceSourceImport } from "../../../src/application/ReferenceSourceImportPolicy.js";
import { createHistoricalSourceManifest } from "../../../src/domain/referenceSourceGraph.js";
import { withArtifactResourceScope } from "../../fixtures/artifactInventory.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { importReferenceSource } from "../../support/referenceSourceResourceScope.js";
import { createReferenceSourceGitFixture } from "../../support/referenceSourceGitFixture.js";

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

it("prepares Git metadata exclusions and keeps directory-only defaults distinct", async () => {
  const root = await createTestTempDirectory("rea-reference-git-policy-");
  const prepared = await withArtifactResourceScope((resources) =>
    prepareReferenceSourceImport(
      { root, caller: "git-metadata-test", policy: { secretPatterns: [] } },
      resources,
    ),
  );
  if (!prepared.ok) throw prepared.error;
  const { ignored } = prepared.value;
  for (const prefix of ["", "nested/"])
    for (const pattern of [".git", ".git/"])
      expect(ignored.test(prefix + pattern)).toMatchObject({
        ignored: true,
        rule: { pattern, mark: "default-ignored" },
      });
  for (const path of [".gitignore", ".github", ".gitkeep", "dist"])
    expect(ignored.test(path).ignored, path).toBe(false);
  expect(ignored.test("dist/")).toMatchObject({
    ignored: true,
    rule: { pattern: "dist/", mark: "default-ignored" },
  });
});

describe.skipIf(process.platform === "win32")(
  "reference source Git metadata exclusions",
  () => {
    it("keeps linked-worktree identities stable while retaining HEAD and ordinary-checkout provenance", async () => {
      const root = await createTestTempDirectory("rea-reference-git-metadata-");
      const repository = join(root, "repository");
      const fixtureGit = await createReferenceSourceGitFixture(root);
      await mkdir(join(repository, "src"), { recursive: true });
      await writeFile(
        join(repository, "src", "main.js"),
        "export const value = 7;\n",
      );
      await writeFile(join(repository, ".gitignore"), "*.log\n");
      const git = (...args: string[]) => fixtureGit(repository, ...args);
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
          (await fixtureGit(worktree, "status", "--porcelain")).stdout,
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
      expect(createHistoricalSourceManifest(left)).toEqual(
        createHistoricalSourceManifest(right),
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

    it("prunes both nested Git metadata kinds and preserves configured-secret precedence", async () => {
      const root = await createTestTempDirectory("rea-reference-nested-git-");
      await Promise.all([
        mkdir(join(root, "pointer")),
        mkdir(join(root, "repository", ".git", "hooks"), { recursive: true }),
      ]);
      await Promise.all([
        writeFile(join(root, "pointer", ".git"), "gitdir: ../metadata\n"),
        writeFile(
          join(root, "repository", ".git", "hooks", "pre-commit"),
          "metadata\n",
        ),
        ...[".gitignore", ".github", ".gitkeep", "dist", "source.js"].map(
          (name) => writeFile(join(root, "pointer", name), ""),
        ),
      ]);

      for (const mode of ["default", "secret"] as const) {
        const secret = mode === "secret";
        const graph = await importTree(
          root,
          secret ? [".git"] : [],
          secret ? ["!.git"] : [],
        );
        const reason = secret ? "configured-secret" : "default-ignored";
        expect(graph.exclusions, mode).toEqual([
          { path: "pointer/.git", entry_kind: "file", reason, pattern: ".git" },
          {
            path: "repository/.git",
            entry_kind: "directory",
            reason,
            pattern: secret ? ".git" : ".git/",
          },
        ]);
        expect(
          graph.entries.map(({ path }) => path),
          mode,
        ).toEqual([
          "pointer",
          "pointer/.github",
          "pointer/.gitignore",
          "pointer/.gitkeep",
          "pointer/dist",
          "pointer/source.js",
          "repository",
        ]);
      }
    });
  },
);
