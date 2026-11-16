import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";

import {
  helperRootRetentionMessage,
  removeHelperRootAtExit,
} from "./DarwinProcessRunTokenReader.js";

// Root ignores the directory's write permission, and Windows has no such
// permission model, so the removal can succeed there for a different reason.
const permissionCase = it.runIf(
  process.platform !== "win32" && process.getuid?.() !== 0,
);

const helperRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "rea-exit-cleanup-"));
  onTestFinished(async () => {
    // A case that removes the root leaves nothing to restore.
    await chmod(root, 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(root, "work"));
  await writeFile(join(root, "work", "reader.swift"), "let value = 1\n");
  return root;
};

const exists = async (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

it("removes an owned helper root", async () => {
  const root = await helperRoot();
  const report = vi.fn();

  removeHelperRootAtExit(root, report);

  expect(await exists(root)).toBe(false);
  expect(report).not.toHaveBeenCalled();
});

permissionCase(
  "keeps a root it cannot remove and names it instead of throwing from the exit listener",
  async () => {
    const root = await helperRoot();
    // A root without write permission keeps its entries, so removal fails.
    await chmod(root, 0o500);

    const report = vi.fn();
    expect(() => {
      removeHelperRootAtExit(root, report);
    }).not.toThrow();

    expect(await exists(root)).toBe(true);
    expect(report).toHaveBeenCalledTimes(1);
    const message = String(report.mock.calls[0]?.[0] ?? "");
    expect(message).toContain(root);
    expect(message).toContain(
      "could not remove the Darwin ownership helper root",
    );
    expect(message.endsWith("\n")).toBe(true);
  },
);
