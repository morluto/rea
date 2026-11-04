import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import type { DesktopPathState } from "../domain/desktop/desktopStateDiff.js";
import { DesktopContentStore } from "./DesktopContentStore.js";
import { walkHomeState } from "./HomeStateWalker.js";

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

/** The walked state of every path under the root. */
const walked = async (root: string) => {
  const { entries } = await walkHomeState([root], [], 100);
  return (path: string): DesktopPathState => {
    const state = entries.get(join(root, path));
    if (state === undefined) throw new Error(`not walked: ${path}`);
    return state;
  };
};

const store = async (root: string, maxFileBytes: number, maxBytes: number) => {
  const created = new DesktopContentStore(
    join(root, "capture"),
    maxFileBytes,
    maxBytes,
  );
  await mkdir(join(root, "capture"));
  await created.prepare();
  return created;
};

describe("DesktopContentStore", () => {
  it("stores each distinct content once and charges the budget once", async () => {
    const root = await createTestTempDirectory("desktop-content-");
    await mkdir(join(root, "files"));
    await writeFile(join(root, "files/a.txt"), "same");
    await writeFile(join(root, "files/b.txt"), "same");
    const state = await walked(join(root, "files"));
    const content = await store(root, 1024, 4);

    const first = await content.retain(
      join(root, "files/a.txt"),
      state("a.txt"),
    );
    const second = await content.retain(
      join(root, "files/b.txt"),
      state("b.txt"),
    );

    expect(first).toEqual({
      kind: "retained",
      sha256: sha256("same"),
      size: 4,
    });
    expect(second).toEqual(first);
    expect(await readdir(join(root, "capture/content"))).toEqual([
      sha256("same"),
    ]);
    expect(
      await readFile(join(root, "capture/content", sha256("same")), "utf8"),
    ).toBe("same");
    expect([content.files, content.bytes]).toEqual([1, 4]);
  });

  it("records why a file was left out", async () => {
    const root = await createTestTempDirectory("desktop-content-omit-");
    await mkdir(join(root, "files/folder"), { recursive: true });
    await writeFile(join(root, "files/big.bin"), "0123456789");
    await writeFile(join(root, "files/a.txt"), "aaaa");
    await writeFile(join(root, "files/b.txt"), "bbbb");
    await writeFile(join(root, "files/later.txt"), "v1");
    await mkdir(join(root, "files/sub"));
    await writeFile(join(root, "files/sub/x.txt"), "x");
    const state = await walked(join(root, "files"));
    await writeFile(join(root, "files/later.txt"), "version 2");
    await rm(join(root, "files/sub"), { recursive: true });
    await writeFile(join(root, "files/sub"), "now a file");
    const content = await store(root, 8, 6);
    const retain = (name: string) =>
      content.retain(join(root, "files", name), state(name));

    expect(await retain("big.bin")).toEqual({
      kind: "omitted",
      reason: "too_large",
    });
    expect((await retain("a.txt")).kind).toBe("retained");
    expect(await retain("b.txt")).toEqual({
      kind: "omitted",
      reason: "budget_exhausted",
    });
    expect(await retain("folder")).toEqual({
      kind: "omitted",
      reason: "unreadable",
    });
    expect(await retain("later.txt")).toEqual({
      kind: "omitted",
      reason: "changed_since_walk",
    });
    expect(await retain("sub/x.txt")).toEqual({
      kind: "omitted",
      reason: "changed_since_walk",
    });
    expect(content.omissions.map((omission) => omission.reason)).toEqual([
      "too_large",
      "budget_exhausted",
      "unreadable",
      "changed_since_walk",
      "changed_since_walk",
    ]);
  });
});
