import { chmod, mkdir, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { AnalysisCancelledError, AnalysisInputError } from "../../domain/analysisErrorCore.js";
import { SafeOutputTreeDestinationRefusal } from "../../artifacts/SafeOutputTreeAdmission.js";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import {
  admitNewOrEmptyOutputDirectory,
  planOutputTree,
  writeOutputTree,
} from "./DesktopOutputTree.js";

it("does not create output parents or invoke the writer after cancellation", async () => {
  const root = await createTestTempDirectory("rea-output-cancel-");
  const directory = join(root, "new-parent", "output");
  const refusal = {
    operation: "export_desktop_application",
    field: "directory",
  };
  const plan = await planOutputTree(directory, refusal);
  const controller = new AbortController();
  const reason = new Error("cancelled before output acquisition");
  controller.abort(reason);
  let written = false;
  const failure = await writeOutputTree(
    plan,
    async () => {
      written = true;
    },
    refusal,
    controller.signal,
  ).catch((cause: unknown) => cause);
  expect(written).toBe(false);
  expect(await readdir(root)).toEqual([]);
  expect(failure).toBeInstanceOf(AnalysisCancelledError);
  expect(failure).toMatchObject({
    operation: refusal.operation,
    cause: reason,
  });
});

const exists = async (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

const refusal = (directory: string) =>
  admitNewOrEmptyOutputDirectory(directory);

describe.skipIf(process.platform === "win32")(
  "admitNewOrEmptyOutputDirectory",
  () => {
    it("admits an absent folder and an existing empty folder", async () => {
      const root = await createTestTempDirectory("output-tree-admit-");
      const empty = join(root, "empty");
      await mkdir(empty);
      await expect(refusal(join(root, "absent"))).resolves.toBeUndefined();
      await expect(refusal(empty)).resolves.toBeUndefined();
    });

    it("refuses a symlink to an empty folder and a dangling symlink", async () => {
      const root = await createTestTempDirectory("output-tree-admit-");
      const target = join(root, "target");
      await mkdir(target);
      const linked = join(root, "linked");
      await symlink(target, linked);
      await expect(refusal(linked)).rejects.toBeInstanceOf(
        SafeOutputTreeDestinationRefusal,
      );
      const dangling = join(root, "dangling");
      await symlink(join(root, "missing"), dangling);
      await expect(refusal(dangling)).rejects.toBeInstanceOf(
        SafeOutputTreeDestinationRefusal,
      );
    });

    it("refuses a regular file, a non-empty folder, and a child of a file", async () => {
      const root = await createTestTempDirectory("output-tree-admit-");
      const file = join(root, "file");
      await writeFile(file, "file");
      await expect(refusal(file)).rejects.toBeInstanceOf(
        SafeOutputTreeDestinationRefusal,
      );
      const full = join(root, "full");
      await mkdir(full);
      await writeFile(join(full, "kept.txt"), "kept");
      await expect(refusal(full)).rejects.toBeInstanceOf(
        SafeOutputTreeDestinationRefusal,
      );
      await expect(refusal(join(file, "out"))).rejects.toBeInstanceOf(
        SafeOutputTreeDestinationRefusal,
      );
    });

    it("refuses a relative path and a trailing .. without creating anything", async () => {
      const root = await createTestTempDirectory("output-tree-admit-");
      await expect(refusal("relative/out")).rejects.toBeInstanceOf(
        SafeOutputTreeDestinationRefusal,
      );
      // Built by string, not `join`: `join` would collapse the `..` away.
      await expect(refusal(`${root}/missing/..`)).rejects.toBeInstanceOf(
        SafeOutputTreeDestinationRefusal,
      );
      expect(await exists(join(root, "missing"))).toBe(false);
    });

    it.skipIf(process.getuid?.() === 0)(
      "refuses an unwritable folder and a child of an unwritable parent",
      async () => {
        const root = await createTestTempDirectory("output-tree-admit-");
        const locked = join(root, "locked");
        await mkdir(locked);
        await chmod(locked, 0o500);
        const parent = join(root, "parent");
        await mkdir(parent);
        await chmod(parent, 0o500);
        try {
          await expect(refusal(locked)).rejects.toBeInstanceOf(
            SafeOutputTreeDestinationRefusal,
          );
          await expect(refusal(join(parent, "out"))).rejects.toBeInstanceOf(
            SafeOutputTreeDestinationRefusal,
          );
        } finally {
          await chmod(locked, 0o700);
          await chmod(parent, 0o700);
        }
      },
    );
  },
);

describe.skipIf(process.platform === "win32")("writeOutputTree", () => {
  // Planning itself refuses a bad destination as invalid input, so a
  // refused directory never reaches the tree; the tests below assert on the
  // error either step raises.
  const writePlanned = async (directory: string) => {
    const plan = await planOutputTree(directory, {
      operation: "test",
      field: "directory",
    });
    return writeOutputTree(
      plan,
      async () => {},
      { operation: "test", field: "directory" },
      undefined,
    );
  };

  it("refuses a trailing .. as invalid input without creating its parent", async () => {
    const root = await createTestTempDirectory("output-tree-write-");
    // Built by string, not `join`: `join` would collapse the `..` away.
    const directory = `${root}/missing/..`;
    const error = await writePlanned(directory).then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(AnalysisInputError);
    if (!(error instanceof AnalysisInputError)) return;
    expect(error.issues).toContainEqual(
      expect.objectContaining({ path: ["directory"], reason: "invalid_value" }),
    );
    expect(await exists(join(root, "missing"))).toBe(false);
  });

  it("refuses a child of a regular file and a symlinked folder as invalid input", async () => {
    const root = await createTestTempDirectory("output-tree-write-");
    const file = join(root, "file");
    await writeFile(file, "file");
    const target = join(root, "target");
    await mkdir(target);
    const linked = join(root, "linked");
    await symlink(target, linked);
    for (const directory of [join(file, "out"), linked]) {
      const error = await writePlanned(directory).then(
        () => undefined,
        (cause: unknown) => cause,
      );
      expect(error).toBeInstanceOf(AnalysisInputError);
      if (!(error instanceof AnalysisInputError)) continue;
      expect(error.issues).toContainEqual(
        expect.objectContaining({
          path: ["directory"],
          reason: "invalid_value",
        }),
      );
    }
  });

  it("writes an absent folder and an existing empty folder", async () => {
    const root = await createTestTempDirectory("output-tree-write-");
    const empty = join(root, "empty");
    await mkdir(empty);
    await expect(writePlanned(join(root, "absent"))).resolves.toMatchObject({
      kind: "published",
      release: undefined,
    });
    expect(await exists(join(root, "absent"))).toBe(true);
    await expect(writePlanned(empty)).resolves.toMatchObject({
      kind: "published",
      release: undefined,
    });
  });
});
