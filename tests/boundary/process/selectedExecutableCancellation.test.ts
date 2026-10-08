import { open, stat, type FileHandle } from "node:fs/promises";
import { expect, it } from "vitest";
import { observeSelectedExecutable } from "../../../src/process/capture/ProcessCaptureLifecycle.js";

it("cancels after real metadata IO without creating an already-aborted stream or leaking the file handle", async () => {
  const controller = new AbortController();
  let opened: FileHandle | undefined;
  await expect(
    observeSelectedExecutable(process.execPath, controller.signal, {
      async open(path, flags) {
        opened = await open(path, flags);
        return opened;
      },
      async stat(path) {
        const metadata = await stat(path, { bigint: true });
        controller.abort();
        return metadata;
      },
    }),
  ).rejects.toMatchObject({ reason: "cancelled" });
  expect(opened?.fd).toBe(-1);
});
