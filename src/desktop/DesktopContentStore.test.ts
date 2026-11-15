import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import type { DesktopPathState } from "../domain/desktop/desktopStateDiff.js";
import { DesktopContentStore } from "./DesktopContentStore.js";
import { walkHomeState } from "./HomeStateWalker.js";
import { OwnedFileHandle } from "../filesystem/OwnedFileHandle.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import { RegularFileCleanupFailure } from "../filesystem/OwnedRegularFile.js";

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

it("DesktopContentStore leaves an occupied partial filename unowned", async () => {
  const root = await createTestTempDirectory("desktop-content-occupied-");
  const content = await store(root, 1024, 1024);
  const bytes = Buffer.from("new content");
  const partial = join(content.directory, `${sha256("new content")}.partial`);
  await writeFile(partial, "foreign content");
  await expect(content.retainBytes(bytes)).rejects.toMatchObject({
    code: "EEXIST",
  });
  await expect(content.discard()).rejects.toThrow();
  expect(await readFile(partial, "utf8")).toBe("foreign content");
});

it("DesktopContentStore retains every unpublished file until discard", async () => {
  const root = await createTestTempDirectory("desktop-content-unpublished-");
  const content = await store(root, 1024, 1024);
  const digests = [sha256("first"), sha256("second")];
  for (const [index, text] of ["first", "second"].entries()) {
    await mkdir(join(content.directory, digests[index]!));
    await expect(content.retainBytes(Buffer.from(text))).rejects.toThrow();
  }
  await expect(content.discard()).rejects.toThrow();
  expect((await readdir(content.directory)).sort()).toEqual(digests.sort());
});

it("DesktopContentStore retains a failed output close until cleanup retry", async () => {
  const root = await createTestTempDirectory("desktop-content-close-");
  const content = await store(root, 1024, 1024);
  const closeFailure = new Error("output descriptor close failed");
  const close = vi
    .spyOn(OwnedFileHandle.prototype, "close")
    .mockRejectedValue(closeFailure);
  try {
    const failure = await content
      .retainBytes(Buffer.from("pending"))
      .catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(RegularFileCleanupFailure);
    if (!(failure instanceof RegularFileCleanupFailure))
      throw new Error("Expected retained output close failure");
    await expect(content.close()).rejects.toMatchObject({
      cleanup: {
        resources: [join(content.directory, `${sha256("pending")}.partial`)],
      },
    });
    close.mockRestore();
    await content.close();
    await expect(failure.owner.handle.stat()).rejects.toMatchObject({
      code: "EBADF",
    });
    await content.discard();
    expect(await readdir(join(root, "capture"))).toEqual([]);
  } finally {
    close.mockRestore();
    await content.close();
  }
});

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

  it("does not read a file larger than the remaining budget", async () => {
    const root = await createTestTempDirectory("desktop-content-budget-");
    await mkdir(join(root, "files"));
    await writeFile(join(root, "files/notes.txt"), "abcdef");
    const state = await walked(join(root, "files"));
    // A read would find the file changed; the budget refuses it first.
    await writeFile(join(root, "files/notes.txt"), "abc");
    const content = await store(root, 1024, 4);

    expect(
      await content.retain(join(root, "files/notes.txt"), state("notes.txt")),
    ).toEqual({ kind: "omitted", reason: "budget_exhausted" });
  });

  it("discards only the files it wrote and refuses to remove other content", async () => {
    const root = await createTestTempDirectory("desktop-content-discard-");
    await mkdir(join(root, "files"));
    await writeFile(join(root, "files/a.txt"), "secret");
    const state = await walked(join(root, "files"));
    const content = await store(root, 1024, 1024);
    await content.retain(join(root, "files/a.txt"), state("a.txt"));

    await content.discard();
    expect(await readdir(join(root, "capture"))).toEqual([]);

    const again = new DesktopContentStore(join(root, "capture"), 1024, 1024);
    await again.prepare();
    await again.retain(join(root, "files/a.txt"), state("a.txt"));
    await writeFile(join(root, "capture/content/foreign"), "kept");
    await expect(again.discard()).rejects.toThrow();
    expect(await readdir(join(root, "capture/content"))).toEqual(["foreign"]);
  });
});

it.each([false, true])(
  "retains read-close cancellation and any actual pending descriptor (close fails: %s)",
  async (closeFails) => {
    const root = await createTestTempDirectory("desktop-content-cancel-");
    await writeFile(join(root, "state.ini"), "state");
    const state = await walked(root);
    const content = await store(root, 1024, 1024);
    const controller = new AbortController();
    const reason = new Error("cancel during actual source descriptor close");
    const close = OwnedFileHandle.prototype.close;
    const closing = vi
      .spyOn(OwnedFileHandle.prototype, "close")
      .mockImplementation(async function (this: OwnedFileHandle) {
        if (!closeFails) await close.call(this);
        controller.abort(reason);
        if (closeFails) throw new Error("source descriptor close failed");
      });
    try {
      const failure = await content
        .retain(join(root, "state.ini"), state("state.ini"), controller.signal)
        .catch((cause: unknown) => cause);
      expect(failure).toBeInstanceOf(ArtifactReaderFailure);
      expect(failure).toMatchObject({ reason: "cancelled", cause: reason });
      if (!(failure instanceof ArtifactReaderFailure))
        throw new Error("expected actual owner cancellation");
      expect(failure.cause).toBe(reason);
      expect(content.files).toBe(0);
      if (closeFails)
        await expect(content.close()).rejects.toMatchObject({
          cleanup: { resources: [join(root, "state.ini")] },
        });
      closing.mockRestore();
      await content.close();
      await content.discard();
      expect(await readFile(join(root, "state.ini"), "utf8")).toBe("state");
    } finally {
      closing.mockRestore();
      await content.close();
      await content.discard();
    }
  },
);
