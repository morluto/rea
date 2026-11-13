import { open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import { locateDenoStandalone } from "../../../src/artifacts/deno/DenoStandaloneLocation.js";
import { locateNodeSea } from "../../../src/artifacts/nodeSea/NodeSeaLocation.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it.each([
  ["Deno", locateDenoStandalone],
  ["Node SEA", locateNodeSea],
] as const)(
  "retains cancellation arriving with carrier EOF for %s",
  async (_name, locate) => {
    const root = await createTestTempDirectory("rea-carrier-eof-");
    const path = join(root, "carrier");
    await writeFile(path, Buffer.alloc(64));
    const handle = await open(path, "r");
    onTestFinished(() => handle.close());
    const controller = new AbortController();
    const reason = new Error("cancelled while reading");
    vi.spyOn(handle, "read").mockImplementationOnce((async (
      buffer: unknown,
    ) => {
      controller.abort(reason);
      return { bytesRead: 0, buffer };
    }) as typeof handle.read);
    await expect(locate(handle, 64, controller.signal)).rejects.toMatchObject({
      reason: "cancelled",
      cause: reason,
    });
  },
);
