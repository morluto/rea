import { lstat, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Stats } from "node:fs";

import { sameDeviceIdentity, sameRegularFileState } from "./RegularFile.js";

const fileState = (dev: number, ino = 1): Stats =>
  ({
    isFile: () => true,
    dev,
    ino,
    size: 4,
    mode: 0o100644,
    mtimeMs: 10,
    ctimeMs: 10,
  }) as Stats;

describe("regular file identity across stat APIs", () => {
  let directory: string | undefined;

  afterEach(async () => {
    if (directory !== undefined) await rm(directory, { recursive: true });
  });

  it("keeps a Windows path stat with device 0 identical to the open handle", () => {
    const opened = fileState(486465838);
    expect(sameDeviceIdentity(0, 486465838)).toBe(process.platform === "win32");
    expect(sameRegularFileState(fileState(0), opened)).toBe(
      process.platform === "win32",
    );
    expect(sameRegularFileState(fileState(1), fileState(2))).toBe(false);
    expect(sameRegularFileState(opened, fileState(486465838, 99))).toBe(false);
  });

  it("accepts the path stat and handle stat of one real file", async () => {
    directory = await mkdtemp(join(tmpdir(), "rea-file-identity-"));
    const path = join(directory, "image.bin");
    await writeFile(path, Buffer.from([0, 1, 2, 3]));
    const handle = await open(path, "r");
    try {
      expect(sameRegularFileState(await lstat(path), await handle.stat())).toBe(
        true,
      );
    } finally {
      await handle.close();
    }
  });
});
