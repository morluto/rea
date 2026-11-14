import { createHash } from "node:crypto";
import { appendFile, symlink, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import {
  RegularFileChangedError,
  openRegularFile,
} from "../../../src/filesystem/RegularFile.js";
import { hashStableRegularFileDescriptor } from "../../../src/filesystem/StableFileHash.js";

const admitted = async (contents: string) => {
  const directory = await createTestTempDirectory("rea-stable-descriptor-");
  const path = join(directory, "target.bin");
  await writeFile(path, contents);
  const source = await openRegularFile(path, { symlinks: "reject" });
  return { directory, path, source };
};

describe("hashStableRegularFileDescriptor", () => {
  it("hashes the admitted bytes and captures the requested prefix", async () => {
    const { path, source } = await admitted("abcdef");
    try {
      expect(
        await hashStableRegularFileDescriptor(source, path, {
          symlinks: "reject",
          prefixBytes: 2,
        }),
      ).toEqual({
        sha256: createHash("sha256").update("abcdef").digest("hex"),
        bytes: 6,
        prefix: Buffer.from("ab"),
      });
    } finally {
      await source.handle.close();
    }
  });

  it.each([
    ["grows", (path: string) => appendFile(path, "more")],
    ["shrinks", (path: string) => truncate(path, 2)],
  ])("refuses a file that %s after admission", async (_change, mutate) => {
    const { path, source } = await admitted("abcdef");
    try {
      await mutate(path);
      await expect(
        hashStableRegularFileDescriptor(source, path, {
          symlinks: "reject",
        }),
      ).rejects.toBeInstanceOf(RegularFileChangedError);
    } finally {
      await source.handle.close();
    }
  });

  // Target admission refuses a symbolic-link final component, while generic
  // hashing follows one; the descriptor owner applies the caller's setting.
  it.skipIf(process.platform === "win32")(
    "applies the caller's symlink setting to a path that names a link",
    async () => {
      const admittedFile = await admitted("abcdef");
      await admittedFile.source.handle.close();
      const { directory, path } = admittedFile;
      const link = join(directory, "link.bin");
      await symlink(path, link);
      const source = await openRegularFile(link, { symlinks: "follow" });
      try {
        await expect(
          hashStableRegularFileDescriptor(source, link, { symlinks: "follow" }),
        ).resolves.toMatchObject({ bytes: 6 });
        await expect(
          hashStableRegularFileDescriptor(source, link, { symlinks: "reject" }),
        ).rejects.toBeInstanceOf(RegularFileChangedError);
      } finally {
        await source.handle.close();
      }
    },
  );
});
