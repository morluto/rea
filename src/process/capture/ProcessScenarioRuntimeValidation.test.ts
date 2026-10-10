import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import {
  resolveExecutable,
  resolveProcessScenarioRuntimePaths,
} from "./ProcessScenarioRuntimeValidation.js";
import { parseProcessScenario } from "../../domain/process/processScenario.js";

it("preserves the caller-selected executable symlink for process invocation", async () => {
  const root = await mkdtemp(join(tmpdir(), "rea-process-executable-alias-"));
  try {
    const alias = join(root, "chosen-node");
    await symlink(process.execPath, alias);

    await expect(resolveExecutable(alias, root, "")).resolves.toBe(alias);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("resolves a Windows executable through the canonical PATH spelling", async () => {
  const root = await mkdtemp(join(tmpdir(), "rea-process-path-"));
  try {
    const selected = join(root, "selected");
    const ambient = join(root, "ambient");
    await mkdir(selected);
    await mkdir(ambient);
    await writeFile(join(selected, "tool.exe"), "");
    await chmod(join(selected, "tool.exe"), 0o644);
    const scenario = parseProcessScenario({
      executable: "tool.exe",
      working_directory: root,
      environment: { Path: selected },
    });
    const candidate = join(selected, "tool.exe");
    try {
      const resolved = await resolveProcessScenarioRuntimePaths(
        scenario,
        { PATH: ambient },
        "win32",
      );
      expect(resolved.executable).toBe(candidate);
    } catch (cause: unknown) {
      const message = cause instanceof Error ? cause.message : String(cause);
      expect(message).toContain(candidate);
      expect(message).not.toContain(ambient);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("retains the selected missing working directory and OS reason", async () => {
  const selected = join(tmpdir(), "rea-process-missing-cwd-unique");
  const scenario = parseProcessScenario({
    executable: process.execPath,
    working_directory: selected,
  });

  await expect(resolveProcessScenarioRuntimePaths(scenario)).rejects.toThrow(
    `working directory could not be resolved: ${selected} (ENOENT)`,
  );
});
