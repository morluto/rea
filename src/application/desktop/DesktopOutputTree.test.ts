import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { AnalysisCancelledError } from "../../domain/analysisErrorCore.js";
import { planOutputTree, writeOutputTree } from "./DesktopOutputTree.js";

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

it("keeps a caller's file when an accepted directory is no longer empty", async () => {
  const root = await createTestTempDirectory("rea-output-late-file-");
  const directory = join(root, "output");
  await mkdir(directory);
  const refusal = {
    operation: "export_desktop_application",
    field: "directory",
  };
  const plan = await planOutputTree(directory, refusal);
  const keep = join(directory, "keep");
  await writeFile(keep, "existing");
  let written = false;
  const failure = await writeOutputTree(
    plan,
    async () => {
      written = true;
    },
    refusal,
    undefined,
  ).catch((cause: unknown) => cause);
  expect(written).toBe(false);
  expect(failure).toMatchObject({
    _tag: "AnalysisInputError",
    operation: refusal.operation,
    userMessage: "Output directory is not empty",
    issues: [
      expect.objectContaining({
        path: [refusal.field],
        message: "Output directory is not empty",
      }),
    ],
  });
  expect(await readFile(keep, "utf8")).toBe("existing");
  expect(await readdir(directory)).toEqual(["keep"]);
});

it("refuses a regular file in the output parent path instead of failing a host write", async () => {
  const root = await createTestTempDirectory("rea-output-file-parent-");
  await writeFile(join(root, "file"), "not a directory");
  const directory = join(root, "file", "nested", "output");
  const refusal = {
    operation: "export_desktop_application",
    field: "directory",
  };
  const failure = await planOutputTree(directory, refusal)
    .then((plan) => writeOutputTree(plan, async () => {}, refusal, undefined))
    .catch((cause: unknown) => cause);
  expect(failure).toMatchObject({
    _tag: "AnalysisInputError",
    operation: refusal.operation,
    issues: [expect.objectContaining({ path: [refusal.field] })],
  });
  expect(await readdir(root)).toEqual(["file"]);
});

it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "refuses an unwritable folder or parent at planning, before anything is created",
  async () => {
    const root = await createTestTempDirectory("rea-output-unwritable-");
    const locked = join(root, "locked");
    await mkdir(locked, { mode: 0o500 });
    const refusal = {
      operation: "export_build_environment",
      field: "directory",
    };
    for (const directory of [locked, join(locked, "nested", "output")]) {
      const failure = await planOutputTree(directory, refusal).catch(
        (cause: unknown) => cause,
      );
      expect(failure).toMatchObject({
        _tag: "AnalysisInputError",
        operation: refusal.operation,
        issues: [expect.objectContaining({ path: [refusal.field] })],
      });
    }
    expect(await readdir(locked)).toEqual([]);
  },
);

it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "refuses a folder whose parent publication cannot open to sync",
  async () => {
    const root = await createTestTempDirectory("rea-output-unreadable-");
    const parent = join(root, "parent");
    await mkdir(join(parent, "empty"), { recursive: true });
    await chmod(parent, 0o300);
    const refusal = {
      operation: "export_build_environment",
      field: "directory",
    };
    try {
      for (const directory of [join(parent, "empty"), join(parent, "absent")])
        await expect(planOutputTree(directory, refusal)).rejects.toMatchObject({
          _tag: "AnalysisInputError",
          issues: [expect.objectContaining({ path: [refusal.field] })],
        });
      // A parent publication creates itself is owner-only, so only the
      // existing ancestor's write access matters there.
      await expect(
        planOutputTree(join(parent, "absent", "output"), refusal),
      ).resolves.toMatchObject({ requested: join(parent, "absent", "output") });
    } finally {
      await chmod(parent, 0o700);
    }
  },
);
