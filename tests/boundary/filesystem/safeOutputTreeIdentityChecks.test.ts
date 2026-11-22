import { createHash } from "node:crypto";
import { rename } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";

import { expect, it, vi } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { SafeOutputTree } from "../../../src/resources/SafeOutputTree.js";

const observation = vi.hoisted(() => ({ paths: [] as string[] }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const filesystem = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...filesystem,
    lstat: async (...args: Parameters<typeof filesystem.lstat>) => {
      observation.paths.push(String(args[0]));
      return filesystem.lstat(...args);
    },
  };
});

const writeText = (tree: SafeOutputTree, path: string, text: string) => {
  const bytes = Buffer.from(text);
  return tree.write(path, Readable.from([bytes]), {
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
};

it("checks each existing ancestor once per level before writing a nested file", async () => {
  const root = await createTestTempDirectory("rea-output-identity-");
  const tree = await SafeOutputTree.create(join(root, "out"));
  await writeText(tree, "a/b/c/first.txt", "first");

  observation.paths.length = 0;
  await writeText(tree, "a/b/c/second.txt", "second");

  const output = tree.outputRoot;
  const directories = [
    output,
    join(output, "a"),
    join(output, "a", "b"),
    join(output, "a", "b", "c"),
  ];
  const directoryChecks = observation.paths.filter((path) =>
    directories.includes(path),
  );
  // Preparing the parents runs one opening root check and a parent/child
  // closing pair per level (7). The write then checks the whole lineage
  // three times, around the open, the stream and the readback (3 x 4).
  // The pre-fix count was 24: duplicate checks with no effect in between.
  expect(directoryChecks).toHaveLength(7 + 12);
  await tree.commit();
});

it("still refuses a nested directory replaced between writes", async () => {
  const root = await createTestTempDirectory("rea-output-identity-");
  const tree = await SafeOutputTree.create(join(root, "out"));
  await writeText(tree, "a/b/first.txt", "first");
  const nested = join(tree.outputRoot, "a", "b");
  await rename(nested, join(tree.outputRoot, "a", "moved"));
  const { mkdir } =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  await mkdir(nested);

  await expect(writeText(tree, "a/b/second.txt", "second")).rejects.toThrow(
    "Extraction directory identity changed",
  );
  await tree.rollback().catch(() => undefined);
});
