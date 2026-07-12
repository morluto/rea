import fs from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { add, commit, init } from "isomorphic-git";
import { describe, expect, it } from "vitest";

import { importReferenceSource } from "../src/application/ReferenceSourceImport.js";
import { createHistoricalSourceManifest } from "../src/domain/referenceSourceGraph.js";

const limits = {
  maxBytes: 1024 * 1024,
  maxEntries: 1_000,
  maxDepth: 16,
  maxPathBytes: 4_096,
};

const fixture = async (parent: string, name: string): Promise<string> => {
  const root = join(parent, name);
  await mkdir(join(root, "src"), { recursive: true });
  await Promise.all([
    writeFile(join(root, "src", "main.ts"), 'import "./dep";\n'),
    writeFile(join(root, "src", "dep.ts"), "export const value = 1;\n"),
    writeFile(join(root, "src", "broken.ts"), "const = ;\n"),
    writeFile(join(root, ".env"), "SECRET_SENTINEL=do-not-record\n"),
    writeFile(join(root, "package.json"), '{"name":"fixture"}\n'),
  ]);
  return root;
};

const importTree = (root: string, approvedRoot: string, signal?: AbortSignal) =>
  importReferenceSource({
    root,
    caller: "reference-import-test",
    policy: {
      roots: [approvedRoot],
      secretPatterns: [".env", ".env.*"],
      ...limits,
    },
    limits,
    ...(signal === undefined ? {} : { signal }),
  });

describe("reference source import", () => {
  it("is relocation-stable, resolves imports, and excludes secrets before capture", async () => {
    const parent = await mkdtemp(join(tmpdir(), "rea-reference-import-"));
    try {
      const leftRoot = await fixture(parent, "left");
      const rightRoot = await fixture(parent, "right");
      const [left, right] = await Promise.all([
        importTree(leftRoot, parent),
        importTree(rightRoot, parent),
      ]);
      expect(left.ok).toBe(true);
      expect(right.ok).toBe(true);
      if (!left.ok || !right.ok) throw new Error("expected imports to pass");
      expect(createHistoricalSourceManifest(left.value)).toEqual(
        createHistoricalSourceManifest(right.value),
      );
      expect(left.value.relationships).toContainEqual(
        expect.objectContaining({
          from_path: "src/main.ts",
          to: "src/dep.ts",
          resolution: "internal",
        }),
      );
      expect(left.value.parse_failures).toHaveLength(1);
      expect(left.value.exclusions).toContainEqual({
        path: ".env",
        reason: "configured-secret",
      });
      expect(JSON.stringify(left.value)).not.toContain("SECRET_SENTINEL");
      expect(JSON.stringify(left.value)).not.toContain(leftRoot);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("fails closed outside policy and honors cancellation", async () => {
    const parent = await mkdtemp(join(tmpdir(), "rea-reference-policy-"));
    const outside = await mkdtemp(join(tmpdir(), "rea-reference-outside-"));
    try {
      const root = await fixture(outside, "tree");
      const denied = await importTree(root, parent);
      expect(denied).toMatchObject({
        ok: false,
        error: { code: "policy" },
      });
      const controller = new AbortController();
      controller.abort();
      const cancelled = await importTree(root, outside, controller.signal);
      expect(cancelled).toMatchObject({
        ok: false,
        error: { code: "cancelled" },
      });
    } finally {
      await Promise.all([
        rm(parent, { recursive: true, force: true }),
        rm(outside, { recursive: true, force: true }),
      ]);
    }
  });

  it("records bounded local Git state without invoking Git", async () => {
    const parent = await mkdtemp(join(tmpdir(), "rea-reference-git-"));
    try {
      const root = await fixture(parent, "repo");
      await init({ fs, dir: root, defaultBranch: "main" });
      for (const filepath of ["package.json", "src/main.ts", "src/dep.ts"])
        await add({ fs, dir: root, filepath });
      const oid = await commit({
        fs,
        dir: root,
        author: { name: "REA Test", email: "rea@example.invalid" },
        message: "fixture",
      });
      const result = await importTree(root, parent);
      expect(result.ok).toBe(true);
      if (!result.ok) throw result.error;
      expect(result.value.vcs).toEqual({ kind: "git", head: oid, dirty: null });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});
