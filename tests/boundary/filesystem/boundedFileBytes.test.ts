import { appendFile, open, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readBoundedFileBytes } from "../../../src/process/BoundedFileBytes.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

describe("bounded file byte reads", () => {
  it.each([0, 65_536])(
    "accepts a file exactly at the %i byte limit",
    async (limit) => {
      const root = await createTestTempDirectory("rea-bounded-bytes-");
      const path = join(root, "input");
      const content = Buffer.alloc(limit, 0x61);
      await writeFile(path, content);
      const handle = await open(path, "r");
      try {
        expect(await readBoundedFileBytes(handle, limit)).toEqual(content);
      } finally {
        await handle.close();
      }
    },
  );

  it("stops after one overflow byte when a file grows beyond its admitted size", async () => {
    const root = await createTestTempDirectory("rea-growing-bytes-");
    const path = join(root, "input");
    await writeFile(path, "0123456789");
    const handle = await open(path, "r");
    try {
      expect((await handle.stat()).size).toBeLessThan(12);
      await appendFile(path, "abcdefghijklmnopqrstuvwxyz");
      expect(await readBoundedFileBytes(handle, 12)).toBeUndefined();
      const next = Buffer.alloc(1);
      expect((await handle.read(next, 0, 1, null)).bytesRead).toBe(1);
      expect(next.toString()).toBe("d");
    } finally {
      await handle.close();
    }
  });
});
