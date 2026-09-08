import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createStoreFileLock,
  removeStaleStoreFileLock,
} from "../../../src/application/StoreFileLock.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

describe("store lock cleanup ownership", () => {
  it.each(["released", "replaced"] as const)(
    "preserves a successor lock when an old %s owner cleans up",
    async (state) => {
      const root = await createTestTempDirectory("rea-store-lock-owner-");
      const path = join(root, "transaction.lock");
      const previous = await createStoreFileLock(path);
      if (state === "released") await previous.release();
      else await rm(path, { recursive: true });
      const successor = await createStoreFileLock(path);
      try {
        await previous.release();
        await expect(lstat(path)).resolves.toBeDefined();
        await expect(createStoreFileLock(path)).rejects.toMatchObject({
          code: "EEXIST",
        });
      } finally {
        await successor.release();
      }
    },
  );
});

describe("store lock acquisition and recovery", () => {
  it("admits one concurrent owner and removes all preparation directories", async () => {
    const root = await createTestTempDirectory("rea-store-lock-contenders-");
    const path = join(root, "transaction.lock");
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => createStoreFileLock(path)),
    );
    try {
      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      for (const result of results)
        if (result.status === "rejected")
          expect(result.reason).toMatchObject({ code: "EEXIST" });
      expect(await readdir(root)).toEqual(["transaction.lock"]);
      expect(await removeStaleStoreFileLock(path)).toBe(false);
    } finally {
      await Promise.all(
        results.map((result) =>
          result.status === "fulfilled" ? result.value.release() : undefined,
        ),
      );
    }
    expect(await readdir(root)).toEqual([]);
  });

  it("recovers a directory lock abandoned by an exited process", async () => {
    const root = await createTestTempDirectory("rea-store-lock-exited-");
    const path = join(root, "transaction.lock");
    await promisify(execFile)(
      process.execPath,
      ["tests/fixtures/abandonStoreFileLock.mjs", path],
      { timeout: 5_000 },
    );
    expect((await lstat(path)).isDirectory()).toBe(true);
    expect(await removeStaleStoreFileLock(path)).toBe(true);
    const successor = await createStoreFileLock(path);
    try {
      expect(await removeStaleStoreFileLock(path)).toBe(false);
    } finally {
      await successor.release();
    }
    expect(await readdir(root)).toEqual([]);
  });
});
