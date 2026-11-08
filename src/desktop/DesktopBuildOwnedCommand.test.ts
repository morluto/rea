import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import * as owned from "../process/OwnedCommand.js";
import { runDesktopBuildOwnedCommand } from "./DesktopBuildOwnedCommand.js";

it("retains a failed cleanup and its partial archive until the same owner succeeds", async () => {
  const root = await createTestTempDirectory("rea-pack-cleanup-retry-");
  const partial = join(root, "partial.tar.xz");
  const workspace = join(root, "work");
  await mkdir(workspace);
  await writeFile(join(workspace, "npm-state"), "in use");
  await writeFile(partial, "partial");
  const resources = new ArtifactResourceScope();
  const stop = vi
    .fn()
    .mockResolvedValueOnce({ status: "incomplete", reason: "still running" })
    .mockResolvedValueOnce({ status: "terminated" });
  const mocked = vi
    .spyOn(owned, "runOwnedCommand")
    .mockImplementation(async (_spawn, _limits, options) => {
      options?.retainCleanup?.(
        { stop, launch: { ownership: { runId: "pack" } } } as never,
        { status: "incomplete", reason: "still running" },
      );
      throw new owned.OwnedCommandFailure("timeout", "command timed out");
    });
  try {
    const failure: unknown = await runDesktopBuildOwnedCommand({
      command: "fixture",
      arguments: [],
      environment: {},
      timeoutMs: 1,
      maxOutputBytes: 1024,
      resources,
      partialPath: partial,
      workspace,
    }).catch((cause: unknown) => cause);
    expect(failure).toMatchObject({
      message: expect.stringContaining("cleanup is incomplete"),
      cause: { reason: "timeout" },
    });
    expect(await readFile(partial, "utf8")).toBe("partial");
    expect(await readFile(join(workspace, "npm-state"), "utf8")).toBe("in use");
    await expect(resources.retryCleanup()).rejects.toThrow();
    expect(await readFile(partial, "utf8")).toBe("partial");
    await resources.retryCleanup();
    await expect(stat(partial)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(workspace)).rejects.toMatchObject({ code: "ENOENT" });
    expect(stop).toHaveBeenCalledTimes(2);
  } finally {
    mocked.mockRestore();
    await resources.close();
  }
});

it("keeps cancellation and partial output when cleanup fails during finalization", async () => {
  const root = await createTestTempDirectory("rea-pack-cancel-cleanup-");
  const partial = join(root, "partial.tar.xz");
  await writeFile(partial, "partial");
  const resources = new ArtifactResourceScope();
  const controller = new AbortController();
  const reason = new Error("cancelled during cleanup");
  const stop = vi.fn().mockResolvedValue({ status: "terminated" });
  const mocked = vi
    .spyOn(owned, "runOwnedCommand")
    .mockImplementation(async (_spawn, _limits, options) => {
      controller.abort(reason);
      options?.retainCleanup?.(
        { stop, launch: { ownership: { runId: "pack" } } } as never,
        { status: "incomplete", reason: "cleanup failed" },
      );
      throw new owned.OwnedCommandFailure(
        "cancelled",
        "Command cancelled",
        null,
        null,
        { cancellation: { reason } },
      );
    });
  try {
    const failure: unknown = await runDesktopBuildOwnedCommand({
      command: "fixture",
      arguments: [],
      environment: {},
      timeoutMs: 1,
      maxOutputBytes: 1024,
      resources,
      partialPath: partial,
      signal: controller.signal,
    }).catch((cause: unknown) => cause);
    expect(failure).toMatchObject({
      message: expect.stringContaining("cleanup is incomplete"),
      cause: { reason: "cancelled", cancellation: { reason } },
    });
    expect(await readFile(partial, "utf8")).toBe("partial");
    await resources.retryCleanup();
    await expect(stat(partial)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    mocked.mockRestore();
    await resources.close();
  }
});

it("does not publish success when execution finishes but cleanup is incomplete", async () => {
  const resources = new ArtifactResourceScope();
  const stop = vi.fn().mockResolvedValue({ status: "terminated" });
  const mocked = vi
    .spyOn(owned, "runOwnedCommand")
    .mockImplementation(async (_spawn, _limits, options) => {
      options?.retainCleanup?.(
        { stop, launch: { ownership: { runId: "pack" } } } as never,
        { status: "incomplete", reason: "child still running" },
      );
      return {} as never;
    });
  try {
    await expect(
      runDesktopBuildOwnedCommand({
        command: "fixture",
        arguments: [],
        environment: {},
        timeoutMs: 1,
        maxOutputBytes: 1024,
        resources,
      }),
    ).rejects.toThrow("cleanup incomplete");
    expect(resources.hasPending).toBe(true);
    await resources.retryCleanup();
    expect(resources.hasPending).toBe(false);
  } finally {
    mocked.mockRestore();
    await resources.close();
  }
});
