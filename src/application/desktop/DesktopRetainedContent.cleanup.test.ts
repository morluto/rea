import { expect, it, vi } from "vitest";
import type { AnalysisCleanupLease } from "../../artifacts/AnalysisCleanupLease.js";
import { AnalysisError } from "../../domain/analysisErrorBase.js";
import { OwnedCommandFailure } from "../../process/OwnedCommand.js";
import { processWorkerCleanup } from "../../process/OwnedWorkerRuntime.js";
import type { ProviderProcessSupervisor } from "../../process/ProviderProcess.js";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import {
  RetainedContent,
  withRetainedContent,
} from "./DesktopRetainedContent.js";
import { retainReaderCleanup } from "./DesktopTaskReaderCleanup.js";

it("retains both reader and capture-file cleanup until both owners release", async () => {
  const folder = await createTestTempDirectory("reader-mixed-cleanup-");
  const process = {
    stop: vi.fn().mockResolvedValue({ status: "stopped" }),
    dispose: vi.fn(),
  } as unknown as ProviderProcessSupervisor;
  const original = retainReaderCleanup(
    folder,
    new OwnedCommandFailure(
      "cancelled",
      "cancelled",
      null,
      "running",
      { cancellation: { reason: "stop" } },
      ["reader-run"],
      process,
    ),
    { views: new Map(), absent: [] },
  );
  if (original === undefined) throw new Error("Expected retained reader");
  const close = vi
    .fn()
    .mockRejectedValueOnce(new Error("file close failed"))
    .mockResolvedValue(undefined);
  let fileLease: AnalysisCleanupLease | undefined;
  const spy = vi
    .spyOn(RetainedContent.prototype, "release")
    .mockImplementation(async (scope) => {
      const attempt = await scope.release({
        kind: "private-runtime-root",
        resource: "capture-file",
        root: { path: "capture-file", close },
      });
      if (attempt.kind !== "failed")
        throw new Error("Expected failed file close");
      fileLease = attempt.lease;
      return [attempt];
    });
  try {
    const combined: unknown = await withRetainedContent("unused", async () => {
      throw original;
    }).catch((cause: unknown) => cause);
    expect(combined).toBeInstanceOf(AnalysisError);
    const failure = combined as AnalysisError;
    expect(failure.cleanupResources).toEqual(
      expect.arrayContaining(["reader-run", folder, "capture-file"]),
    );
    await processWorkerCleanup.retry();
    expect(failure.cleanupIncomplete).toBe(true);
    if (fileLease === undefined) throw new Error("Missing retained file lease");
    await fileLease.release();
    expect(failure.cleanupIncomplete).toBe(false);
    expect(close).toHaveBeenCalledTimes(2);
  } finally {
    spy.mockRestore();
    await processWorkerCleanup.retry();
    await fileLease?.release();
  }
});
