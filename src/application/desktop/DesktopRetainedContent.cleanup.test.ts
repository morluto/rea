import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import { OwnedFileHandle } from "../../filesystem/OwnedFileHandle.js";
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

it.each([
  {
    label: "completed bytes after failed close",
    abort: false,
    denyClose: true,
    capacity: false,
  },
  {
    label: "cancellation after confirmed close",
    abort: true,
    denyClose: false,
    capacity: false,
  },
  {
    label: "cancellation beside failed close",
    abort: true,
    denyClose: true,
    capacity: false,
  },
  {
    label: "capacity refusal beside later cancellation",
    abort: true,
    denyClose: false,
    capacity: true,
  },
])(
  "retains the owned read outcome and descriptor through $label",
  async ({ abort, denyClose, capacity }) => {
    const folder = await createTestTempDirectory("retained-origin-");
    await mkdir(join(folder, "content"));
    const bytes = Buffer.from("kept");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const path = join(folder, "content", sha256);
    await writeFile(path, bytes);
    const content = new RetainedContent(folder, capacity ? 0 : 1024);
    const resources = new ArtifactResourceScope();
    const controller = new AbortController();
    const reason = { code: "EACCES", source: "caller" };
    const closeFailure = new Error(
      "controlled retained descriptor close failure",
    );
    let refusingClose = denyClose;
    const owners: OwnedFileHandle[] = [];
    const nativeClose = OwnedFileHandle.prototype.close;
    const spy = vi
      .spyOn(OwnedFileHandle.prototype, "close")
      .mockImplementation(async function (this: OwnedFileHandle) {
        owners.push(this);
        if (refusingClose) {
          if (abort) controller.abort(reason);
          throw closeFailure;
        }
        await nativeClose.call(this);
        if (abort) controller.abort(reason);
      });
    try {
      const result = await content.read(sha256, controller.signal).then(
        (value) => ({ returned: true as const, value }),
        (cause: unknown) => ({ returned: false as const, cause }),
      );
      if (abort && !capacity) {
        expect(result.returned).toBe(false);
        if (result.returned) throw new Error("Expected owned cancellation");
        expect(result.cause).toBeInstanceOf(ArtifactReaderFailure);
        if (!(result.cause instanceof ArtifactReaderFailure))
          throw result.cause;
        expect(result.cause.reason).toBe("cancelled");
        expect(result.cause.cause).toBe(reason);
        expect(result.cause.cancellation?.reason).toBe(reason);
      } else {
        expect(result.returned).toBe(true);
        if (!result.returned) throw result.cause;
        expect(result.value).toEqual(
          capacity
            ? { ok: false, error: "is larger than the 0 MiB read limit" }
            : { ok: true, value: bytes },
        );
      }
      const owner = owners[0];
      const failed = await content.release(resources);
      expect(failed).toHaveLength(denyClose ? 1 : 0);
      if (denyClose) {
        expect(owner?.handle.fd).toBeGreaterThanOrEqual(0);
        expect(failed[0]?.cause).toBe(closeFailure);
        expect(failed[0]?.owner).toMatchObject({
          kind: "file-handle",
          resource: path,
          handle: owner,
        });
        const retainedOwner = failed[0]?.owner;
        if (retainedOwner?.kind !== "file-handle")
          throw new Error("Expected exact retained descriptor owner");
        expect(retainedOwner.handle).toBe(owner);
        expect(resources.cleanupResources).toEqual([path]);
        expect(failed[0]?.lease.released).toBe(false);
        refusingClose = false;
        await resources.retryCleanup();
        expect(failed[0]?.lease.released).toBe(true);
      }
      expect(owner?.handle.fd).toBe(-1);
      expect(resources.cleanupResources).toEqual([]);
    } finally {
      refusingClose = false;
      spy.mockRestore();
      await content.release(resources);
      await resources.close();
    }
  },
);
