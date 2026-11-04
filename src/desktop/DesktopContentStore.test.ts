import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { DesktopContentStore } from "./DesktopContentStore.js";

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

describe("DesktopContentStore", () => {
  it("stores each distinct content once under its SHA-256", async () => {
    const root = await createTestTempDirectory("desktop-content-");
    await writeFile(join(root, "a.txt"), "same");
    await writeFile(join(root, "b.txt"), "same");
    const store = new DesktopContentStore(join(root, "capture"), 1024, 4096);
    await store.prepare();

    const first = await store.retain(join(root, "a.txt"));
    const second = await store.retain(join(root, "b.txt"));

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
    expect([store.files, store.bytes]).toEqual([1, 4]);
  });

  it("records why a file was left out", async () => {
    const root = await createTestTempDirectory("desktop-content-omit-");
    await writeFile(join(root, "big.bin"), "0123456789");
    await writeFile(join(root, "a.txt"), "aaaa");
    await writeFile(join(root, "b.txt"), "bbbb");
    await mkdir(join(root, "folder"));
    const store = new DesktopContentStore(join(root, "capture"), 8, 6);
    await store.prepare();

    expect(await store.retain(join(root, "big.bin"))).toEqual({
      kind: "omitted",
      reason: "too_large",
    });
    expect((await store.retain(join(root, "a.txt"))).kind).toBe("retained");
    expect(await store.retain(join(root, "b.txt"))).toEqual({
      kind: "omitted",
      reason: "budget_exhausted",
    });
    expect(await store.retain(join(root, "folder"))).toEqual({
      kind: "omitted",
      reason: "unreadable",
    });
    expect(await store.retain(join(root, "missing"))).toEqual({
      kind: "omitted",
      reason: "unreadable",
    });
    expect(store.omissions.map((omission) => omission.reason)).toEqual([
      "too_large",
      "budget_exhausted",
      "unreadable",
      "unreadable",
    ]);
  });
});
