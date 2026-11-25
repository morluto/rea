import { createHash } from "node:crypto";
import { lstat, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";

import { expect, it, vi } from "vitest";

import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { SafeOutputTree } from "../../src/resources/SafeOutputTree.js";

const boundary = vi.hoisted(() => ({
  decomposedDirectory: null as string | null,
}));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readdir: async (...args: unknown[]) => {
      const entries: unknown = await Reflect.apply(
        actual.readdir,
        undefined,
        args,
      );
      return args[0] === boundary.decomposedDirectory &&
        Array.isArray(entries) &&
        entries.every((name): name is string => typeof name === "string")
        ? entries.map((name) => name.normalize("NFD"))
        : entries;
    },
  };
});

const writeAccent = async (tree: SafeOutputTree) => {
  const bytes = Buffer.from("owned");
  await tree.write("café.txt", Readable.from([bytes]), {
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
};

it("accepts a decomposed directory listing while verifying the original owned file identity", async () => {
  const root = await createTestTempDirectory("rea-output-unicode-");
  const tree = await SafeOutputTree.create(join(root, "output"));
  const original = join(tree.outputRoot, "café.txt");
  const decomposed = join(tree.outputRoot, "cafe\u0301.txt");
  try {
    await writeAccent(tree);
    const before = await lstat(original, { bigint: true });
    const alternate = await lstat(decomposed, { bigint: true }).catch(
      (cause: unknown) => {
        if (
          cause instanceof Error &&
          "code" in cause &&
          cause.code === "ENOENT"
        )
          return undefined;
        throw cause;
      },
    );
    if (alternate !== undefined) {
      expect(alternate).toMatchObject({ dev: before.dev, ino: before.ino });
      const staged = join(root, "owned-staging-file");
      await rename(original, staged);
      await rename(staged, decomposed);
    }
    // Some filesystems cannot return a decomposed listing for this same file.
    if ((await readdir(tree.outputRoot))[0] === "café.txt")
      boundary.decomposedDirectory = tree.outputRoot;
    expect(await readdir(tree.outputRoot)).toEqual(["cafe\u0301.txt"]);
    await tree.commit();
    expect(tree.published).toBe(true);
    expect(await readFile(original, "utf8")).toBe("owned");
  } finally {
    boundary.decomposedDirectory = null;
    await tree.closeHandles();
  }
});

it.skipIf(process.platform !== "linux")(
  "does not collapse an additional canonically equivalent foreign filename",
  async () => {
    const root = await createTestTempDirectory("rea-output-unicode-foreign-");
    const output = join(root, "output");
    const tree = await SafeOutputTree.create(output);
    await writeAccent(tree);
    const foreign = join(output, "cafe\u0301.txt");
    await writeFile(foreign, "foreign", { flag: "wx" });
    try {
      await expect(tree.commit()).rejects.toThrow("Unowned or missing");
      expect(await readFile(foreign, "utf8")).toBe("foreign");
    } finally {
      await tree.closeHandles();
    }
  },
);
