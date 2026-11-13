import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import * as owned from "../process/OwnedCommand.js";
import { runDesktopBuildOwnedCommand } from "./DesktopBuildOwnedCommand.js";
import { systemDesktopBuildSetupHost } from "./DesktopBuildSetupHost.js";
import {
  AnalysisCancelledError,
  AnalysisOutputError,
} from "../domain/analysisErrorCore.js";
import { awaitAcknowledgement } from "../../tests/fixtures/lifecycleAcknowledgement.js";

it
  .skipIf(process.platform === "win32" || process.getuid?.() === 0)
  .each([true, false])(
  "reports only remaining setup resources after partial cleanup (process retained: %s)",
  async (processRetained) => {
    const root = await createTestTempDirectory("rea-pack-live-cleanup-");
    const partial = join(root, "partial.tar.xz");
    const parent = join(root, "protected");
    const workspace = join(parent, "work");
    await mkdir(workspace, { recursive: true });
    await writeFile(partial, "partial");
    await chmod(parent, 0o500);
    const resources = new ArtifactResourceScope();
    const stop = vi.fn().mockResolvedValue({ status: "terminated" });
    const command = vi
      .spyOn(owned, "runOwnedCommand")
      .mockImplementation(async (_spawn, _limits, options) => {
        if (processRetained)
          options?.retainCleanup?.(
            { stop, launch: { ownership: { runId: "pack" } } } as never,
            { status: "incomplete", reason: "still running" },
          );
        throw new owned.OwnedCommandFailure("timeout", "command timed out");
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
          partialPath: partial,
          workspace,
        }),
      ).rejects.toThrow();
      if (processRetained) {
        expect(resources.cleanupResources).toEqual([
          partial,
          workspace,
          "setup process pack",
        ]);
        await expect(resources.retryCleanup()).rejects.toThrow();
      }
      expect(resources.cleanupResources).toEqual([workspace]);
      await expect(stat(partial)).rejects.toMatchObject({ code: "ENOENT" });
      await chmod(parent, 0o700);
      await resources.retryCleanup();
      expect(resources.cleanupResources).toEqual([]);
      expect(stop).toHaveBeenCalledTimes(processRetained ? 1 : 0);
      await expect(stat(workspace)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      try {
        try {
          await chmod(parent, 0o700);
        } finally {
          await resources.close();
        }
      } finally {
        command.mockRestore();
      }
    }
  },
);

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
    expect(failure).toBeInstanceOf(AnalysisCancelledError);
    if (!(failure instanceof AnalysisCancelledError)) throw failure;
    expect(failure.cause).toBe(reason);
    expect(failure.secondaryFailures[0]?.cause).toMatchObject({
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

it("retains an observed command failure when cancellation arrives during its cleanup", async () => {
  const resources = new ArtifactResourceScope();
  const controller = new AbortController();
  const reason = new Error("cancel during cleanup");
  let entered!: () => void;
  let release!: () => void;
  const cleanupEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const cleanupRelease = new Promise<void>((resolve) => {
    release = resolve;
  });
  const snapshot = {
    stdout: { text: "earlier output", bytes: 14, observedBytes: 14 },
    stderr: { text: "disk full", bytes: 9, observedBytes: 9 },
    exitCode: 2,
    signal: null,
  };
  const primary = new owned.OwnedCommandFailure(
    "process",
    "Command failed",
    snapshot,
  );
  const mocked = vi
    .spyOn(owned, "runOwnedCommand")
    .mockImplementation(async () => {
      entered();
      await cleanupRelease;
      throw new owned.OwnedCommandFailure(
        "process",
        primary.message,
        snapshot,
        null,
        {
          cause: primary,
          cancellation: { reason: controller.signal.reason },
        },
      );
    });
  const host = systemDesktopBuildSetupHost(
    {},
    process.platform,
    undefined,
    resources,
  );
  const pending = host.installAgentenv("fixture", controller.signal);
  try {
    await awaitAcknowledgement(cleanupEntered, pending, "command cleanup");
    controller.abort(reason);
    release();
    const failure: unknown = await pending.catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(AnalysisOutputError);
    if (!(failure instanceof AnalysisOutputError)) throw failure;
    expect(failure.diagnostics).toMatchObject({ command_failure: "process" });
    expect(failure.capturedOutput).toMatchObject({
      stdout: "earlier output",
      stderr: "disk full",
      exit_code: 2,
    });
    expect(failure.cause).toMatchObject({
      reason: "process",
      cause: primary,
    });
    expect(failure.secondaryFailures[0]).toBeInstanceOf(AnalysisCancelledError);
    expect(failure.secondaryFailures[0]?.cause).toBe(reason);
  } finally {
    controller.abort();
    release();
    await Promise.allSettled([pending]);
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
