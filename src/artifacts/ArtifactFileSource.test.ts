import { open, writeFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { ArtifactFileSource } from "./ArtifactFileSource.js";

it("retries an admission cancelled after opening and closing the selected descriptor", async () => {
  const path = join(
    await createTestTempDirectory("rea-artifact-source-cancel-"),
    "input",
  );
  await writeFile(path, "source");
  const source = new ArtifactFileSource(path, "fixture");
  const controller = new AbortController();
  const reason = { stop: "admission" };
  const observed = await open(path, "r");
  const prototype = Object.getPrototypeOf(observed) as FileHandle;
  const stat = prototype.stat;
  let stopped = false;
  const spy = vi.spyOn(prototype, "stat").mockImplementation(async function (
    this: FileHandle,
    ...args: Parameters<typeof stat>
  ) {
    const result = await stat.apply(this, args);
    if (!stopped) {
      stopped = true;
      controller.abort(reason);
    }
    return result;
  });
  try {
    await expect(source.read(controller.signal)).rejects.toMatchObject({
      reason: "cancelled",
    });
    spy.mockRestore();
    expect((await source.read()).initial.size).toBe(6);
  } finally {
    spy.mockRestore();
    await observed.close();
    await source.close();
  }
});

it("does not replace an admission owner when its descriptor close failed", async () => {
  const path = join(
    await createTestTempDirectory("rea-artifact-source-held-"),
    "input",
  );
  await writeFile(path, "source");
  const source = new ArtifactFileSource(path, "fixture");
  const controller = new AbortController();
  const reason = { stop: "admission" };
  const observed = await open(path, "r");
  const prototype = Object.getPrototypeOf(observed) as FileHandle;
  const stat = prototype.stat;
  const spy = vi.spyOn(prototype, "stat").mockImplementation(async function (
    this: FileHandle,
    ...args: Parameters<typeof stat>
  ) {
    const result = await stat.apply(this, args);
    controller.abort(reason);
    return result;
  });
  const { OwnedFileHandle } = await import("../filesystem/OwnedFileHandle.js");
  const close = OwnedFileHandle.prototype.close;
  let attempts = 0;
  const closeSpy = vi
    .spyOn(OwnedFileHandle.prototype, "close")
    .mockImplementation(function (this: InstanceType<typeof OwnedFileHandle>) {
      if (++attempts === 1) return Promise.reject(new Error("close denied"));
      return close.call(this);
    });
  try {
    const failure = await source
      .read(controller.signal)
      .catch((cause: unknown) => cause);
    expect(failure).toMatchObject({
      reason: "cancelled",
      cleanup: { resources: [path] },
    });
    spy.mockRestore();
    await expect(source.read()).rejects.toBe(failure);
    expect(attempts).toBe(1);
    await source.close();
    expect(attempts).toBe(2);
  } finally {
    spy.mockRestore();
    closeSpy.mockRestore();
    await observed.close();
    await source.close();
  }
});

it("lets another caller continue when shared admission is cancelled", async () => {
  const path = join(
    await createTestTempDirectory("rea-artifact-source-shared-"),
    "input",
  );
  await writeFile(path, "source");
  const source = new ArtifactFileSource(path, "fixture");
  const controller = new AbortController();
  const reason = { stop: "first admission" };
  const observed = await open(path, "r");
  const prototype = Object.getPrototypeOf(observed) as FileHandle;
  const stat = prototype.stat;
  let entered!: () => void;
  let resume!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  let firstStat = true;
  const spy = vi.spyOn(prototype, "stat").mockImplementation(async function (
    this: FileHandle,
    ...args: Parameters<typeof stat>
  ) {
    const result = await stat.apply(this, args);
    if (firstStat) {
      firstStat = false;
      entered();
      await gate;
    }
    return result;
  });
  try {
    const first = source.read(controller.signal);
    const rejected = first.then(
      () => {
        throw new Error("Expected cancellation");
      },
      (cause: unknown) => cause,
    );
    await started;
    const second = source.read();
    await Promise.resolve();
    controller.abort(reason);
    resume();
    expect(await rejected).toMatchObject({
      reason: "cancelled",
      cause: reason,
    });
    expect((await second).initial.size).toBe(6);
  } finally {
    resume();
    spy.mockRestore();
    await observed.close();
    await source.close();
  }
});
