import { open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { readFileHandleChunks } from "../../filesystem/readFileHandleChunks.js";
import {
  ProcessCaptureReadFailure,
  withProcessCaptureFile,
} from "./ProcessCaptureRead.js";

it.each(["same", "distinct"] as const)(
  "keeps an actual native read failure primary after %s cancellation during close",
  async (reasonKind) => {
    const root = await createTestTempDirectory("rea-capture-read-origin-");
    const path = join(root, "write-only");
    const file = await open(path, "w");
    const controller = new AbortController();
    const close = file.close.bind(file);
    let physical: unknown;
    const distinct = { caller: "after physical read" };
    const closing = vi.spyOn(file, "close").mockImplementation(async () => {
      await close();
      controller.abort(reasonKind === "same" ? physical : distinct);
    });
    try {
      const result: unknown = await withProcessCaptureFile(
        path,
        file,
        controller.signal,
        undefined,
        async (owned) => {
          try {
            for await (const _chunk of readFileHandleChunks(owned, {
              signal: controller.signal,
            })) {
              throw new Error(
                "A write-only descriptor must not yield read bytes",
              );
            }
          } catch (cause: unknown) {
            physical = cause;
            throw cause;
          }
        },
      ).catch((cause: unknown) => cause);
      expect(physical).toMatchObject({ code: "EBADF" });
      expect(result).toBeInstanceOf(ProcessCaptureReadFailure);
      if (!(result instanceof ProcessCaptureReadFailure)) throw result;
      expect(result.reason).toBe("capture_failed");
      expect(result.userCategory).toBeUndefined();
      expect(result.cause).toBe(physical);
      expect(result.outcome).toEqual({ kind: "failed", cause: physical });
      expect(result.cancellation?.reason).toBe(
        reasonKind === "same" ? physical : distinct,
      );
      expect(result.cleanupIncomplete).toBe(false);
      expect(file.fd).toBe(-1);
    } finally {
      closing.mockRestore();
      await file.close();
    }
  },
);

it.each(["stream", "completed"] as const)(
  "retains actual %s cancellation recorded by the file owner",
  async (stage) => {
    const root = await createTestTempDirectory("rea-capture-read-cancel-");
    const path = join(root, "input");
    await writeFile(path, "inert bytes");
    const file = await open(path, "r");
    const controller = new AbortController();
    const reason = { caller: "stop descriptor observation" };
    const close = file.close.bind(file);
    const closing = vi.spyOn(file, "close").mockImplementation(async () => {
      await close();
      if (stage === "completed") controller.abort(reason);
    });
    try {
      const result: unknown = await withProcessCaptureFile(
        path,
        file,
        controller.signal,
        undefined,
        async (owned) => {
          if (stage === "stream") controller.abort(reason);
          const chunks: Buffer[] = [];
          for await (const chunk of readFileHandleChunks(owned, {
            signal: controller.signal,
          }))
            chunks.push(chunk);
          return Buffer.concat(chunks).toString("utf8");
        },
      ).catch((cause: unknown) => cause);
      expect(result).toBeInstanceOf(ProcessCaptureReadFailure);
      if (!(result instanceof ProcessCaptureReadFailure)) throw result;
      expect(result.reason).toBe("cancelled");
      expect(result.cause).toBe(reason);
      expect(result.cancellation?.reason).toBe(reason);
      expect(result.outcome.kind).toBe(
        stage === "stream" ? "failed" : "completed",
      );
      expect(result.cleanupIncomplete).toBe(false);
      expect(file.fd).toBe(-1);
    } finally {
      closing.mockRestore();
      await file.close();
    }
  },
);
