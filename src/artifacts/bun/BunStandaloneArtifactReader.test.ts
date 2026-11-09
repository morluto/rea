import { open, writeFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { buffer } from "node:stream/consumers";
import { expect, it, vi } from "vitest";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import * as artifactPaths from "../ArtifactPaths.js";
import { BunStandaloneArtifactReader } from "../BunStandaloneArtifactReader.js";
import {
  bunModuleGraphPayload,
  elfAppendedBunPayload,
} from "./BunStandalone.fixture.js";

it("keeps duplicate and unsafe names distinct while extracting exact bytes", async () => {
  const path = join(await createTestTempDirectory("rea-bun-reader-"), "app");
  await writeFile(
    path,
    elfAppendedBunPayload(
      bunModuleGraphPayload({
        modules: [
          { name: "/$bunfs/a.js", contents: Buffer.from("first") },
          { name: "/$bunfs/a.js", contents: Buffer.from("second") },
          { name: "../../escape", contents: Buffer.from("third") },
        ],
      }),
    ),
  );
  const reader = new BunStandaloneArtifactReader(path);
  try {
    const entries = await collect(reader.entries());
    expect(entries.map((entry) => entry.path)).toEqual([
      "$bunfs/a.js",
      "$bunfs/a.js",
      "bun-modules/2",
    ]);
    expect(new Set(entries.map((entry) => entry.adapterKey)).size).toBe(3);
    for (const [index, entry] of entries.entries())
      expect((await buffer(await reader.open(entry))).toString()).toBe(
        ["first", "second", "third"][index],
      );
    const entry = entries[0]!;
    await expect(
      reader.open({ ...entry, byteOffset: 0 }),
    ).rejects.toMatchObject({ reason: "integrity" });
    const controller = new AbortController();
    controller.abort();
    await expect(reader.open(entry, controller.signal)).rejects.toMatchObject({
      reason: "cancelled",
    });
    await writeFile(path, "changed");
    await expect(reader.open(entry)).rejects.toMatchObject({
      reason: "integrity",
    });
  } finally {
    await reader.close();
  }
  await expect(collect(reader.entries())).rejects.toMatchObject({
    reason: "unavailable",
  });
});

async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const value of values) result.push(value);
  return result;
}

it("allows an uncancelled inventory after a cancelled graph preparation", async () => {
  const path = join(
    await createTestTempDirectory("rea-bun-cancel-retry-"),
    "app",
  );
  await writeFile(
    path,
    elfAppendedBunPayload(
      bunModuleGraphPayload({
        modules: [{ name: "/$bunfs/a.js", contents: Buffer.from("source") }],
      }),
    ),
  );
  const reader = new BunStandaloneArtifactReader(path);
  const controller = new AbortController();
  const reason = { stop: "first inventory" };
  const observed = await open(path, "r");
  const prototype = Object.getPrototypeOf(observed) as FileHandle;
  const original = prototype.read;
  let stopped = false;
  const spy = vi.spyOn(prototype, "read").mockImplementation(async function (
    this: FileHandle,
    ...args: Parameters<typeof original>
  ) {
    const result = await original.apply(this, args);
    if (!stopped) {
      stopped = true;
      controller.abort(reason);
    }
    return result;
  });
  try {
    await expect(
      collect(reader.entries(controller.signal)),
    ).rejects.toMatchObject({ reason: "cancelled" });
    spy.mockRestore();
    const entries = await collect(reader.entries());
    expect(entries.map((entry) => entry.path)).toEqual(["$bunfs/a.js"]);
    expect((await buffer(await reader.open(entries[0]!))).toString()).toBe(
      "source",
    );
  } finally {
    spy.mockRestore();
    await observed.close();
    await reader.close();
  }
});

it("keeps another caller's in-flight inventory independent of cancelled preparation", async () => {
  const path = join(
    await createTestTempDirectory("rea-bun-concurrent-cancel-"),
    "app",
  );
  await writeFile(
    path,
    elfAppendedBunPayload(
      bunModuleGraphPayload({
        modules: [{ name: "/$bunfs/a.js", contents: Buffer.from("source") }],
      }),
    ),
  );
  const reader = new BunStandaloneArtifactReader(path);
  const controller = new AbortController();
  const reason = { stop: "first inventory" };
  const observed = await open(path, "r");
  const prototype = Object.getPrototypeOf(observed) as FileHandle;
  const original = prototype.read;
  let entered!: () => void;
  let resume!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  let firstRead = true;
  const spy = vi.spyOn(prototype, "read").mockImplementation(async function (
    this: FileHandle,
    ...args: Parameters<typeof original>
  ) {
    const result = await original.apply(this, args);
    if (firstRead) {
      firstRead = false;
      entered();
      await gate;
    }
    return result;
  });
  try {
    const first = collect(reader.entries(controller.signal));
    const rejected = first.then(
      () => {
        throw new Error("Expected cancellation");
      },
      (cause: unknown) => cause,
    );
    await started;
    const second = collect(reader.entries());
    controller.abort(reason);
    resume();
    expect(await rejected).toMatchObject({
      reason: "cancelled",
      cause: reason,
    });
    expect((await second).map((entry) => entry.path)).toEqual(["$bunfs/a.js"]);
  } finally {
    resume();
    spy.mockRestore();
    await observed.close();
    await reader.close();
  }
});

it("keeps an independent physical read failure when its caller also aborts", async () => {
  const path = join(
    await createTestTempDirectory("rea-bun-physical-failure-"),
    "app",
  );
  await writeFile(
    path,
    elfAppendedBunPayload(
      bunModuleGraphPayload({
        modules: [{ name: "/$bunfs/a.js", contents: Buffer.from("source") }],
      }),
    ),
  );
  const reader = new BunStandaloneArtifactReader(path);
  const controller = new AbortController();
  const failure = Object.assign(new Error("physical graph read failed"), {
    code: "EIO",
  });
  const observed = await open(path, "r");
  const prototype = Object.getPrototypeOf(observed) as FileHandle;
  const spy = vi.spyOn(prototype, "read").mockImplementationOnce(async () => {
    controller.abort(failure);
    throw failure;
  });
  try {
    await expect(collect(reader.entries(controller.signal))).rejects.toBe(
      failure,
    );
    spy.mockRestore();
    expect(
      (await collect(reader.entries())).map((entry) => entry.path),
    ).toEqual(["$bunfs/a.js"]);
  } finally {
    spy.mockRestore();
    await observed.close();
    await reader.close();
  }
});

it("does not publish partially built entries when preparation is cancelled", async () => {
  const path = join(
    await createTestTempDirectory("rea-bun-partial-build-"),
    "app",
  );
  await writeFile(
    path,
    elfAppendedBunPayload(
      bunModuleGraphPayload({
        modules: [
          { name: "/$bunfs/a.js", contents: Buffer.from("a") },
          { name: "/$bunfs/b.js", contents: Buffer.from("b") },
          { name: "/$bunfs/c.js", contents: Buffer.from("c") },
        ],
      }),
    ),
  );
  const reader = new BunStandaloneArtifactReader(path);
  const control = new BunStandaloneArtifactReader(path);
  const controller = new AbortController();
  const reason = { stop: "during inventory construction" };
  const normalize = artifactPaths.normalizeArtifactPath;
  const expected = await collect(control.entries());
  const spy = vi
    .spyOn(artifactPaths, "normalizeArtifactPath")
    .mockImplementation((name) => {
      if (name === "$bunfs/b.js") controller.abort(reason);
      return normalize(name);
    });
  try {
    await expect(
      collect(reader.entries(controller.signal)),
    ).rejects.toMatchObject({ reason: "cancelled", cause: reason });
    spy.mockRestore();
    await expect(reader.open(expected[0]!)).rejects.toMatchObject({
      reason: "integrity",
    });
    expect(
      (await collect(reader.entries())).map((entry) => entry.path),
    ).toEqual(["$bunfs/a.js", "$bunfs/b.js", "$bunfs/c.js"]);
  } finally {
    spy.mockRestore();
    await reader.close();
    await control.close();
  }
});
