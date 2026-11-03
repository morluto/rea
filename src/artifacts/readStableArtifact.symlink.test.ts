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
      message: expect.stringContaining(resolved),
      userMessage: expect.stringContaining(resolved),
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
      message: expect.stringContaining(selected),
      userMessage: expect.stringContaining(selected),
    });
    const failure: unknown = await readStableArtifact(selected, 1024).catch(
      (cause: unknown) => cause,
    );
    expect((failure as { userMessage: string }).userMessage).not.toContain(
      join(root, "missing.bin"),
    );
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

it.skipIf(process.platform === "win32")(
  "keeps a failed target lookup distinct from a dangling symlink",
  async () => {
    const root = await createTestTempDirectory("rea-stable-lookup-error-");
    const target = join(root, "target.bin");
    const selected = join(root, "selected.bin");
    await writeFile(target, "bytes");
    await symlink(target, selected);
    const lookupError = Object.assign(new Error("permission denied"), {
      code: "EACCES",
    });
    const failure: unknown = await readStableArtifact(
      selected,
      1024,
      undefined,
      {
        lstat: (path) => lstat(path, { bigint: true }),
        open,
        realpath: () => Promise.reject(lookupError),
      },
    ).catch((cause: unknown) => cause);
    expect(failure).toMatchObject({
      reason: "path",
      message: expect.stringContaining("EACCES"),
      userMessage: expect.stringContaining(selected),
    });
    expect((failure as { userMessage: string }).userMessage).toContain(
      "EACCES",
    );
    expect((failure as Error).cause).toBe(lookupError);
  },
);
