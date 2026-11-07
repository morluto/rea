import {
  chmod,
  mkdir,
  readFile,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import { requirePermissionDenial } from "../../../tests/fixtures/permissionDenial.js";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { AnalysisInputError } from "../../domain/analysisErrorCore.js";
import {
  checkOutputTreeDestination,
  writeOutputTree,
} from "./DesktopOutputTree.js";

const CONTEXT = {
  provider: "agentenv",
  operation: "check_build_task",
  field: "directory",
};

const REFUSAL = {
  operation: "check_build_task",
  field: "directory",
};

const expectRefusedError = (error: unknown): void => {
  expect(error).toBeInstanceOf(AnalysisInputError);
  if (!(error instanceof AnalysisInputError)) return;
  expect(error.operation).toBe("check_build_task");
  expect(error.issues).toMatchObject([
    { path: ["directory"], reason: "invalid_value" },
  ]);
};

const expectRefusedDestination = async (directory: string): Promise<void> => {
  const checked = await checkOutputTreeDestination(directory, CONTEXT);
  expect(checked.ok).toBe(false);
  if (!checked.ok) expectRefusedError(checked.error);
  let thrown: unknown;
  let wrote = false;
  try {
    await writeOutputTree(
      directory,
      async () => {
        wrote = true;
      },
      REFUSAL,
      undefined,
    );
  } catch (cause: unknown) {
    thrown = cause;
  }
  expect(wrote).toBe(false);
  expectRefusedError(thrown);
};

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

describe("DesktopOutputTree", () => {
  it("refuses non-directory targets and parents as invalid input", async () => {
    const root = await createTestTempDirectory("desktop-output-tree-");
    const regularFile = join(root, "file");
    await writeFile(regularFile, "occupied");
    const nonEmpty = join(root, "occupied");
    await mkdir(nonEmpty);
    await writeFile(join(nonEmpty, "keep"), "");

    for (const candidate of [
      "relative/output",
      regularFile,
      join(regularFile, "out"),
      join(regularFile, "nested", "out"),
      nonEmpty,
    ]) {
      await expectRefusedDestination(candidate);
    }

    const fresh = join(root, "fresh", "out");
    const checked = await checkOutputTreeDestination(fresh, CONTEXT);
    expect(checked.ok).toBe(true);
    const bytes = Buffer.from("ok");
    const release = await writeOutputTree(
      fresh,
      async (tree) => {
        await tree.write("witness.json", Readable.from([bytes]));
      },
      REFUSAL,
      undefined,
    );
    expect(release).toBeUndefined();
    expect(await readFile(join(fresh, "witness.json"), "utf8")).toBe("ok");
  });

  it.skipIf(process.platform === "win32")(
    "refuses symlinks and parent traversal basenames without creating folders",
    async () => {
      const root = await createTestTempDirectory("desktop-output-symlink-");
      const emptyTarget = join(root, "empty-target");
      await mkdir(emptyTarget);
      const emptyLink = join(root, "empty-link");
      await symlink(emptyTarget, emptyLink);
      const absentTarget = join(root, "absent-target");
      const danglingLink = join(root, "dangling-link");
      await symlink(absentTarget, danglingLink);
      const missingParent = join(root, "missing");

      for (const candidate of [
        emptyLink,
        `${emptyLink}/`,
        danglingLink,
        join(danglingLink, "out"),
        `${missingParent}/..`,
      ]) {
        await expectRefusedDestination(candidate);
      }

      expect(await pathExists(missingParent)).toBe(false);
      expect(await pathExists(absentTarget)).toBe(false);
    },
  );

  it.skipIf(process.platform === "win32")(
    "preserves POSIX symlink parent traversal when writing a nested folder",
    async () => {
      const root = await createTestTempDirectory("desktop-output-traversal-");
      const outer = join(root, "outer");
      const inner = join(outer, "inner");
      await mkdir(inner, { recursive: true });
      const link = join(root, "link");
      await symlink(inner, link);
      const destination = `${link}/../nested/out`;

      const checked = await checkOutputTreeDestination(destination, CONTEXT);
      expect(checked.ok).toBe(true);
      const bytes = Buffer.from("ok");
      const release = await writeOutputTree(
        destination,
        async (tree) => {
          await tree.write("witness.json", Readable.from([bytes]));
        },
        REFUSAL,
        undefined,
      );
      expect(release).toBeUndefined();
      const written = join(outer, "nested", "out", "witness.json");
      expect(await readFile(written, "utf8")).toBe("ok");
      expect(await pathExists(join(root, "nested"))).toBe(false);
    },
  );

  it.skipIf(process.platform === "win32")(
    "refuses unwritable empty folders and unwritable ancestor directories",
    async (context) => {
      await requirePermissionDenial(context, "directory-write");
      const root = await createTestTempDirectory("desktop-output-readonly-");
      const lockedEmpty = join(root, "locked-empty");
      const lockedParent = join(root, "locked-parent");
      await mkdir(lockedEmpty);
      await mkdir(lockedParent);
      await chmod(lockedEmpty, 0o500);
      await chmod(lockedParent, 0o500);
      try {
        await expectRefusedDestination(lockedEmpty);
        await expectRefusedDestination(join(lockedParent, "out"));
        await expectRefusedDestination(join(lockedParent, "nested", "out"));
      } finally {
        await chmod(lockedEmpty, 0o700);
        await chmod(lockedParent, 0o700);
      }
    },
  );
});
