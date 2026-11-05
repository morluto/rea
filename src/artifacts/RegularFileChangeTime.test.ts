import type { Stats } from "node:fs";
import { lstat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import {
  changedOnlyInChangeTimeDrift,
  sameRegularFileState,
  sameRegularFileStateAllowingChangeTimeDrift,
} from "../filesystem/RegularFile.js";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";

const itOnWindows = it.skipIf(process.platform !== "win32");

/** Reproduce the ChangeTime Windows reports after the drift settled. */
const withChangeTime = (stats: Stats, ctimeMs: number): Stats =>
  Object.assign(
    Object.create(Object.getPrototypeOf(stats) as object) as Stats,
    stats,
    { ctimeMs },
  );

itOnWindows(
  "tolerates the post-write ChangeTime drift of a freshly written file",
  async () => {
    const root = await createTestTempDirectory("rea-change-time-drift-");
    const path = join(root, "freshly-written.bin");
    await writeFile(path, "fresh contents\n");
    const written = await lstat(path);

    const drifted = withChangeTime(written, written.ctimeMs + 500);

    expect(sameRegularFileState(written, drifted)).toBe(false);
    expect(changedOnlyInChangeTimeDrift(written, drifted)).toBe(true);
    expect(sameRegularFileStateAllowingChangeTimeDrift(written, drifted)).toBe(
      true,
    );
  },
);

itOnWindows(
  "still reports a rewrite whose modification time was restored",
  async () => {
    const root = await createTestTempDirectory("rea-change-time-rewrite-");
    const path = join(root, "restored-mtime.bin");
    const restored = new Date("2020-01-02T03:04:05.000Z");
    await writeFile(path, "before\n");
    await utimes(path, restored, restored);
    const expected = await lstat(path);

    await writeFile(path, "after!\n");
    await utimes(path, restored, restored);
    const rewritten = await lstat(path);

    expect(rewritten.mtimeMs).toBe(expected.mtimeMs);
    expect(rewritten.ctimeMs).not.toBe(expected.ctimeMs);

    expect(changedOnlyInChangeTimeDrift(expected, rewritten)).toBe(false);
    expect(
      sameRegularFileStateAllowingChangeTimeDrift(expected, rewritten),
    ).toBe(false);
  },
);

it("keeps the strict comparison unchanged on every platform", async () => {
  const root = await createTestTempDirectory("rea-change-time-strict-");
  const path = join(root, "strict.bin");
  await writeFile(path, "contents\n");
  const written = await lstat(path);

  const drifted = withChangeTime(written, written.ctimeMs + 500);

  expect(sameRegularFileState(written, drifted)).toBe(false);
  expect(changedOnlyInChangeTimeDrift(written, drifted)).toBe(
    process.platform === "win32",
  );
});
