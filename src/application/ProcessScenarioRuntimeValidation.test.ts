import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import {
  resolveExecutable,
  resolveProcessScenarioRuntimePaths,
} from "./ProcessScenarioRuntimeValidation.js";
import { parseProcessScenario } from "../domain/processCapture.js";

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
