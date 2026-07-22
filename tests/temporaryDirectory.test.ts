import { access, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "./fixtures/temporaryDirectory.js";

describe.sequential("test temporary directory ownership", () => {
  let completedDirectory: string | undefined;

  it("creates a canonical directory owned by the current test", async () => {
    const directory = await createTestTempDirectory("rea-owned-temp-");
    completedDirectory = directory;

    expect(directory).toBe(await realpath(directory));
    expect(dirname(directory)).toBe(await realpath(tmpdir()));
    await writeFile(join(directory, "nested.txt"), "owned");
  });

  it("removes the prior test directory after that test finishes", async () => {
    const directory = completedDirectory;
    if (directory === undefined)
      throw new Error("Prior test did not create a directory");
    await expect(access(directory)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.each(["", "../escape-", "/absolute-", "missing-dash"])(
    "rejects unsafe prefix %j",
    async (prefix) => {
      await expect(createTestTempDirectory(prefix)).rejects.toThrow(TypeError);
    },
  );
});
