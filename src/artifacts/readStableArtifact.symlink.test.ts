import { lstat, open, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { readStableArtifact } from "./readStableArtifact.js";

it.skipIf(process.platform === "win32")(
  "refuses a selected symlink and names its resolved target without reading it",
  async () => {
    const root = await createTestTempDirectory("rea-stable-symlink-");
    const target = join(root, "target.bin");
    const selected = join(root, "selected.bin");
    await writeFile(target, "bytes");
    await symlink(target, selected);
    const resolved = await realpath(target);
    await expect(readStableArtifact(selected, 1024)).rejects.toMatchObject({
      reason: "path",
      message: `Expected a regular file without a symlink: ${selected} (it resolves to ${resolved})`,
      userMessage: `The selected path is a symlink to ${resolved}. Symlinks are not followed; if that target is the intended artifact, retry with path ${resolved}.`,
    });
    await expect(readStableArtifact(resolved, 1024)).resolves.toMatchObject({
      bytes: Buffer.from("bytes"),
    });
  },
);

it.skipIf(process.platform === "win32")(
  "reports a dangling selected symlink without inventing a target",
  async () => {
    const root = await createTestTempDirectory("rea-stable-dangling-");
    const selected = join(root, "selected.bin");
    await symlink(join(root, "missing.bin"), selected);
    await expect(readStableArtifact(selected, 1024)).rejects.toMatchObject({
      reason: "path",
      message: `Expected a regular file without a symlink: ${selected} (its target does not currently resolve)`,
      userMessage: `The selected path is a symlink whose target does not currently resolve: ${selected}. Select an existing regular file directly, then retry.`,
    });
  },
);

it.skipIf(process.platform === "win32")(
  "keeps the plain refusal when the filesystem boundary cannot resolve paths",
  async () => {
    const root = await createTestTempDirectory("rea-stable-no-realpath-");
    const target = join(root, "target.bin");
    const selected = join(root, "selected.bin");
    await writeFile(target, "bytes");
    await symlink(target, selected);
    await expect(
      readStableArtifact(selected, 1024, undefined, {
        lstat: (path) => lstat(path, { bigint: true }),
        open,
      }),
    ).rejects.toMatchObject({
      reason: "path",
      message: `Expected a regular file without a symlink: ${selected}`,
      userMessage: undefined,
    });
  },
);
