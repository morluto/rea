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
        const actual = await readBoundedFileBytes(handle, limit);
        if (actual === undefined)
          throw new Error("Expected complete file bytes");
        expect(actual.equals(content)).toBe(true);
      } finally {
        await handle.close();
      }
    },
  );

  it.each([undefined, 0, 5])(
    "preserves raw reasons or caller-owned cancellation with expected size %s",
    async (expectedSize) => {
      const root = await createTestTempDirectory("rea-bounded-cancel-");
      const path = join(root, "input");
      await writeFile(path, "hello");
      const handle = await open(path, "r");
      try {
        for (const reason of [null, "stopped", new Error("stopped")]) {
          const controller = new AbortController();
          controller.abort(reason);
          await expect(
            readBoundedFileBytes(handle, 5, {
              signal: controller.signal,
              expectedSize,
            }),
          ).rejects.toBe(reason);
          const typed = new Error("typed cancellation", { cause: reason });
          await expect(
            readBoundedFileBytes(handle, 5, {
              signal: controller.signal,
              expectedSize,
              cancellationFailure: (observed) => {
                expect(observed).toBe(reason);
                return typed;
              },
            }),
          ).rejects.toBe(typed);
        }
      } finally {
        await handle.close();
      }
    },
  );

  it.each([
    { contents: "", maxBytes: 0, expectedSize: undefined, outcome: "EOF" },
    { contents: "", maxBytes: 5, expectedSize: 5, outcome: "early EOF" },
    {
      contents: "hello",
      maxBytes: 5,
      expectedSize: 5,
      outcome: "expected size",
    },
    {
      contents: "hello",
      maxBytes: 4,
      expectedSize: undefined,
      outcome: "overflow",
    },
  ])(
    "honors cancellation while the $outcome read is in flight",
    async ({ contents, maxBytes, expectedSize }) => {
      const root = await createTestTempDirectory("rea-bounded-cancel-read-");
      const path = join(root, "input");
      await writeFile(path, contents);
      const handle = await open(path, "r");
      const controller = new AbortController();
      const reason = new Error("cancelled during read");
      const typed = new Error("typed cancellation", { cause: reason });
      try {
        const result = readBoundedFileBytes(handle, maxBytes, {
          signal: controller.signal,
          expectedSize,
          cancellationFailure: (observed) => {
            expect(observed).toBe(reason);
            return typed;
          },
        });
        controller.abort(reason);
        await expect(result).rejects.toBe(typed);
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

describe("bounded file byte reads with expectedSize", () => {
  it.each([0, 65_536])(
    "accepts a file matching expectedSize %i at the byte limit",
    async (limit) => {
      const root = await createTestTempDirectory("rea-bounded-expected-");
      const path = join(root, "input");
      const content = Buffer.alloc(limit, 0x62);
      await writeFile(path, content);
      const handle = await open(path, "r");
      try {
        const actual = await readBoundedFileBytes(handle, limit, {
          expectedSize: limit,
        });
        if (actual === undefined)
          throw new Error("Expected complete file bytes");
        expect(actual.equals(content)).toBe(true);
      } finally {
        await handle.close();
      }
    },
  );

  it.each([0, 10])(
    "detects growth past maxBytes when expectedSize equals maxBytes (%i)",
    async (expectedSize) => {
      const root = await createTestTempDirectory("rea-growing-expected-");
      const path = join(root, "input");
      await writeFile(path, "0".repeat(expectedSize));
      const handle = await open(path, "r");
      try {
        await appendFile(path, "abcdef");
        expect(
          await readBoundedFileBytes(handle, expectedSize, { expectedSize }),
        ).toBeUndefined();
        const next = Buffer.alloc(1);
        expect((await handle.read(next, 0, 1, null)).bytesRead).toBe(1);
        expect(next.toString()).toBe("b");
      } finally {
        await handle.close();
      }
    },
  );

  it("reads through EOF when a file grows beyond expectedSize but stays within maxBytes", async () => {
    const root = await createTestTempDirectory("rea-growing-within-max-");
    const path = join(root, "input");
    await writeFile(path, "hello");
    const handle = await open(path, "r");
    try {
      await appendFile(path, " world!");
      const actual = await readBoundedFileBytes(handle, 32, {
        expectedSize: 5,
      });
      if (actual === undefined) throw new Error("Expected complete file bytes");
      expect(actual.toString("utf8")).toBe("hello world!");
    } finally {
      await handle.close();
    }
  });

  it("returns undefined when a file grows beyond expectedSize and exceeds maxBytes", async () => {
    const root = await createTestTempDirectory("rea-growing-past-max-");
    const path = join(root, "input");
    await writeFile(path, "hello");
    const handle = await open(path, "r");
    try {
      await appendFile(path, "0123456789");
      expect(
        await readBoundedFileBytes(handle, 10, { expectedSize: 5 }),
      ).toBeUndefined();
    } finally {
      await handle.close();
    }
  });
});
