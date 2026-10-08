import fs from "node:fs";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { add, commit, init } from "isomorphic-git";
import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

import {
  importReferenceSource,
  normalizeHistoricalSourceParseFailures,
} from "../../../src/application/ReferenceSourceImport.js";
import { projectReferenceSourceEntryFailure } from "../../../src/application/ReferenceSourceImportEntries.js";
import {
  projectReferenceSourceImportError,
  type ReferenceSourceImportError,
} from "../../../src/application/ReferenceSourceImportTypes.js";
import { createHistoricalSourceManifest } from "../../../src/domain/referenceSourceGraph.js";

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

const importTree = (
  root: string,
  signal?: AbortSignal,
  secretPatterns: readonly string[] = [".env", ".env.*"],
) =>
  importReferenceSource({
    root,
    caller: "reference-import-test",
    policy: {
      secretPatterns,
    },
    ...(signal === undefined ? {} : { signal }),
  });

describe("reference source import error projection", () => {
  it("deduplicates exact parse failures without collapsing distinct reasons", () => {
    const malformed = {
      path: "src/main.ts",
      parser: "babel",
      reason: "Malformed input",
    };
    const unexpected = {
      path: "src/main.ts",
      parser: "babel",
      reason: "Unexpected token",
    };

    expect(
      normalizeHistoricalSourceParseFailures([
        unexpected,
        malformed,
        unexpected,
      ]),
    ).toEqual([malformed, unexpected]);
  });

  it("retains entry failure diagnostics alongside recovery guidance", () => {
    for (const [kind, code] of [
      ["directory", "io"],
      ["symlink", "io"],
      ["file", "io"],
      ["file", "cancelled"],
      ["unknown", "unsupported"],
    ] as const) {
      const message = projectReferenceSourceEntryFailure({
        status: "failed",
        path: "safe/path",
        kind,
        code,
        message: "Observed entry failure at /owned/fixture/path",
      });
      expect(message).toContain(
        "Observed entry failure at /owned/fixture/path",
      );
      expect(message).toMatch(/Check|try again|when ready|Exclude/u);
    }
  });

  it("projects every import failure without raw parser or policy text", () => {
    const expectedCategories = {
      cancelled: "cancelled",
      "invalid-root": "invalid_input",
      unsupported: "unsupported_host",
      io: "execution_failure",
      parse: "execution_failure",
    } as const;
    for (const [code, category] of Object.entries(expectedCategories)) {
      const projected = projectReferenceSourceImportError({
        tag: "reference-source-import",
        code: code as ReferenceSourceImportError["code"],
        message: "SECRET parser stack and /private/path",
      });
      expect(projected.category).toBe(category);
      expect(projected.message).not.toContain("SECRET");
      expect(projected.message).not.toContain("/private/path");
      expect(projected.message).toMatch(
        /try again|when ready|Check that|REA on Linux/u,
      );
    }
  });
});

describe("reference source symlink import", () => {
  it("retains external symlink targets as local graph diagnostics", async () => {
    const root = await createTestTempDirectory("rea-reference-links-");
    const outside = await createTestTempDirectory("rea-reference-outside-");
    const target = join(outside, "target.js");
    await writeFile(target, "export {};");
    await symlink(target, join(root, "external.js"));

    const imported = await importTree(root);

    if (!imported.ok) throw imported.error;
    expect(imported.value.entries).toContainEqual(
      expect.objectContaining({
        kind: "symlink",
        path: "external.js",
        target,
        target_state: "external",
        limitations: [],
      }),
    );
    expect(imported.value.entries).not.toContainEqual(
      expect.objectContaining({ path: "target.js", kind: "file" }),
    );
  });
});

describe("reference source manifest inventory", () => {
  it("retains CMake build manifests in the imported inventory", async () => {
    const root = await createTestTempDirectory("rea-reference-cmake-");
    await mkdir(join(root, "src"));
    await Promise.all([
      writeFile(join(root, "CMakeLists.txt"), "project(example)\n"),
      writeFile(
        join(root, "src", "CMakeLists.txt"),
        "add_library(example main.cpp)\n",
      ),
      writeFile(join(root, "notes.txt"), "Build notes.\n"),
    ]);

    const result = await importTree(root);
    if (!result.ok) throw result.error;
    expect(result.value.manifests).toEqual([
      "CMakeLists.txt",
      "src/CMakeLists.txt",
    ]);
    expect(result.value.entries).toContainEqual(
      expect.objectContaining({
        path: "CMakeLists.txt",
        classifications: ["documentation", "manifest"],
      }),
    );
    expect(result.value.entries).toContainEqual(
      expect.objectContaining({
        path: "src/CMakeLists.txt",
        classifications: ["documentation", "manifest", "source"],
      }),
    );
  });
});

describe("reference source import behavior", () => {
  // The importer declares no byte ceiling and no entry-count ceiling. Scale
  // independence cannot be asserted as a relationship over a bounded fixture,
  // because a cap above the fixture size would pass unnoticed, so the fixture
  // has to cross any ceiling a future change would plausibly introduce: 5,000
  // entries is well past a round 1,000 or 2,000 cap, and one 4 MiB member is
  // well past a 1 MiB cap.
  //
  // The two boundaries are crossed independently rather than as a cross
  // product. Cycling the sizes over every entry would make a thousand 4 MiB
  // members, which is nearly 4 GiB of fixture and cannot fit a runner's disk.
  // Entry count is crossed by volume, byte size by a single large member.
  it("returns every written entry with complete coverage at any scale", async () => {
    const root = await createTestTempDirectory("rea-reference-scale-");
    const sizes = [0, 1, 4_097, 65_536, 4_194_304];
    const written = Array.from(
      { length: 5_000 },
      (_, index) => `entry-${String(index).padStart(5, "0")}.txt`,
    );
    // Only the first entry of each size takes that size; the remaining 4,995
    // stay one byte each. The fixture is therefore about 4.2 MiB in total
    // while still containing a member far larger than any byte ceiling.
    const sizeFor = (index: number): number => sizes[index] ?? 1;
    await Promise.all(
      written.map((name, index) =>
        writeFile(join(root, name), "a".repeat(sizeFor(index))),
      ),
    );

    const result = await importReferenceSource({
      root,
      caller: "reference-import-test",
      policy: { secretPatterns: [] },
    });

    if (!result.ok) throw result.error;
    // The importer always reports one standing advisory about pathname races,
    // so completeness is asserted per entry rather than globally.
    const limited = result.value.entries.filter(
      (entry) => entry.limitations.length > 0,
    );
    expect(limited.map((entry) => entry.path)).toEqual([]);
    expect(result.value.entries).toHaveLength(written.length);
    expect(new Set(result.value.entries.map((entry) => entry.path))).toEqual(
      new Set(written),
    );
    // Members of every size must still be hashed rather than skipped or
    // truncated, including the 4 MiB member, so each entry is checked against
    // the size it was actually written with.
    for (const [index, size] of sizes.entries()) {
      expect(result.value.entries).toContainEqual(
        expect.objectContaining({
          path: `entry-${String(index).padStart(5, "0")}.txt`,
          kind: "file",
          size,
          content_state: "hashed",
        }),
      );
    }
    // The bulk of the fixture must also survive intact, so a cap on either
    // dimension fails even though only five entries carry a distinct size.
    const bulk = result.value.entries.filter(
      (entry) =>
        Number.parseInt(entry.path.replace("entry-", ""), 10) >= sizes.length,
    );
    expect(bulk).toHaveLength(written.length - sizes.length);
    expect(bulk.every((entry) => "size" in entry && entry.size === 1)).toBe(
      true,
    );
    // `inventory_state` is deliberately not asserted to equal "complete": the
    // importer always reports a standing advisory that Node cannot offer
    // descriptor-relative openat traversal, which forces "partial" on every
    // host. Completeness is proven above at the entry level, where it is
    // actually meaningful.
  });

  it("imports BMP and supplementary filenames in Unicode code point order", async () => {
    const root = await createTestTempDirectory("reference-unicode-");
    try {
      const paths = ["\uE000.ts", "\u{10000}.ts"];
      await Promise.all(
        paths.map((path) =>
          writeFile(join(root, path), "export const value = 1;\n"),
        ),
      );
      const result = await importTree(root);
      if (!result.ok) throw result.error;
      expect(result.value.entries.map(({ path }) => path)).toEqual(paths);
      const repeated = await importTree(root);
      expect(repeated).toEqual(result);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("is relocation-stable, resolves imports, and excludes secrets before capture", async () => {
    const parent = await createTestTempDirectory("rea-reference-import-");
    try {
      const leftRoot = await fixture(parent, "left");
      const rightRoot = await fixture(parent, "right");
      const [left, right] = await Promise.all([
        importTree(leftRoot),
        importTree(rightRoot),
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

  it("imports the caller-selected directory and honors cancellation", async () => {
    const outside = await createTestTempDirectory("rea-reference-outside-");
    try {
      const root = await fixture(outside, "tree");
      expect(await importTree(root)).toMatchObject({ ok: true });
      const controller = new AbortController();
      controller.abort();
      const cancelled = await importTree(root, controller.signal);
      expect(cancelled).toMatchObject({
        ok: false,
        error: { code: "cancelled" },
      });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("records bounded local Git state without invoking Git", async () => {
    const parent = await createTestTempDirectory("rea-reference-git-");
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
      const result = await importTree(root);
      if (!result.ok) throw result.error;
      expect(result.value.vcs).toEqual({ kind: "git", head: oid, dirty: null });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});

describe("reference source path selection", () => {
  it("does not omit selected files by secret-like path or filename", async () => {
    const parent = await createTestTempDirectory("rea-reference-selected-");
    try {
      const root = await fixture(parent, "tree");
      const result = await importTree(root, undefined, []);
      if (!result.ok) throw result.error;
      expect(result.value.entries).toContainEqual(
        expect.objectContaining({
          path: ".env",
          kind: "file",
          content_state: "hashed",
        }),
      );
      expect(result.value.exclusions).not.toContainEqual(
        expect.objectContaining({ path: ".env" }),
      );
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});

describe("reference source rooted module specifiers", () => {
  it("does not rebase an absolute import onto a coincidentally matching source member", async () => {
    const root = await createTestTempDirectory("rea-reference-rooted-");
    await mkdir(join(root, "src", "outside"), { recursive: true });
    await writeFile(
      join(root, "src", "main.js"),
      'import "/outside/dep.js"; import "./outside/dep.js";\n',
    );
    await writeFile(
      join(root, "src", "outside", "dep.js"),
      "export const value = 1;\n",
    );
    const result = await importTree(root);
    if (!result.ok) throw result.error;
    expect(result.value.relationships).toContainEqual({
      from_path: "src/main.js",
      to: "/outside/dep.js",
      kind: "imports",
      resolution: "unresolved",
      parse_state: "parsed",
    });
    expect(result.value.relationships).toContainEqual({
      from_path: "src/main.js",
      to: "src/outside/dep.js",
      kind: "imports",
      resolution: "internal",
      parse_state: "parsed",
    });
  });
});
