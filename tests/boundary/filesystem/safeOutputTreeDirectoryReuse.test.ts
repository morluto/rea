import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

import { SafeOutputTree } from "../../../src/artifacts/SafeOutputTree.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    mkdir: vi.fn(actual.mkdir),
    readdir: vi.fn(actual.readdir),
  };
});

const writeText = (tree: SafeOutputTree, path: string, text: string) =>
  tree.write(path, Readable.from(Buffer.from(text)), {
    sha256: createHash("sha256").update(text).digest("hex"),
    bytes: Buffer.byteLength(text),
  });

const isCaseSensitive = async (directory: string): Promise<boolean> => {
  await writeFile(join(directory, "case-probe"), "lower");
  await writeFile(join(directory, "CASE-PROBE"), "upper");
  return (await readFile(join(directory, "case-probe"), "utf8")) === "lower";
};

const calledPaths = (spy: typeof mkdir | typeof readdir): unknown[] =>
  vi.mocked(spy).mock.calls.map(([path]) => path);

describe("safe artifact output nested directory reuse", () => {
  beforeEach(() => {
    vi.mocked(mkdir).mockClear();
    vi.mocked(readdir).mockClear();
  });

  it("reuses an owned nested directory without mkdir or a case scan", async () => {
    const parent = await createTestTempDirectory("rea-safe-output-reuse-");
    const output = join(parent, "published");
    const tree = await SafeOutputTree.create(output);

    await writeText(tree, "Lib/first.txt", "first");
    expect(calledPaths(mkdir)).toContain(join(output, "Lib"));
    vi.mocked(mkdir).mockClear();
    vi.mocked(readdir).mockClear();

    await writeText(tree, "Lib/second.txt", "second");
    expect(calledPaths(mkdir)).toEqual([]);
    expect(calledPaths(readdir)).toEqual([]);
    await tree.commit();
    expect((await readdir(join(output, "Lib"))).sort()).toEqual([
      "first.txt",
      "second.txt",
    ]);
  });

  it("still sends another spelling of an owned directory through mkdir and the case scan", async () => {
    const parent = await createTestTempDirectory("rea-safe-output-case-");
    const caseSensitive = await isCaseSensitive(parent);
    const output = join(parent, "published");
    const tree = await SafeOutputTree.create(output);

    await writeText(tree, "Lib/first.txt", "first");
    await writeText(tree, "Lib/second.txt", "second");
    vi.mocked(mkdir).mockClear();
    vi.mocked(readdir).mockClear();
    const sibling = writeText(tree, "lib/third.txt", "third");
    if (caseSensitive) {
      await sibling;
      expect(calledPaths(mkdir)).toEqual([join(output, "lib")]);
      await tree.commit();
      expect((await readdir(output)).sort()).toEqual(["Lib", "lib"]);
      return;
    }
    await expect(sibling).rejects.toThrow(
      "Destination filesystem cannot store both lib and Lib",
    );
    expect(calledPaths(mkdir)).toEqual([join(output, "lib")]);
    expect(calledPaths(readdir)).toEqual([output]);
    expect((await readdir(join(output, "Lib"))).sort()).toEqual([
      "first.txt",
      "second.txt",
    ]);
    expect(await tree.rollback()).toEqual({
      status: "complete",
      residualPaths: [],
    });
  });

  it("refuses to recreate an owned nested directory removed between writes", async () => {
    const parent = await createTestTempDirectory("rea-safe-output-removed-");
    const output = join(parent, "published");
    const tree = await SafeOutputTree.create(output);

    await writeText(tree, "nested/first.txt", "first");
    await rm(join(output, "nested"), { recursive: true });
    await expect(
      writeText(tree, "nested/second.txt", "second"),
    ).rejects.toThrow();
    await expect(access(join(output, "nested"))).rejects.toThrow();
  });
});
