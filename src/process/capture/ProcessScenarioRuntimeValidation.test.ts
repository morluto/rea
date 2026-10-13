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

import { AnalysisInputError } from "../../domain/analysisErrorCore.js";
import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";
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
      const message =
        cause instanceof AnalysisInputError
          ? (cause.issues[0]?.message ?? cause.message)
          : cause instanceof Error
            ? cause.message
            : String(cause);
      expect(message).toContain(candidate);
      expect(message).not.toContain(ambient);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("reports a working-directory file as invalid input", async () => {
  const root = await mkdtemp(join(tmpdir(), "rea-process-invalid-cwd-"));
  const selectedFile = join(root, "selected-file");
  await writeFile(selectedFile, "not a directory");
  try {
    const failure = await runtimePathFailure({
      executable: process.execPath,
      working_directory: selectedFile,
    });
    expect(projectAnalysisError(failure)).toMatchObject({
      code: "invalid_request",
      details: {
        operation: "capture_process_scenario",
        issues: [
          {
            path: ["working_directory"],
            reason: "invalid_value",
            message: `working directory is not a directory: ${selectedFile}`,
          },
        ],
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("reports an executable directory as invalid input", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "rea-process-executable-directory-"),
  );
  const directory = join(root, "tool-directory");
  try {
    await mkdir(directory);
    const directoryFailure = await runtimePathFailure({
      executable: directory,
      working_directory: root,
    });
    expect(projectAnalysisError(directoryFailure)).toMatchObject({
      code: "invalid_request",
      details: {
        issues: [
          {
            path: ["executable"],
            message: `executable could not be resolved: ${directory}; checked ${directory} (not a regular file)`,
          },
        ],
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.skipIf(process.platform === "win32")(
  "reports a non-executable regular file as invalid input",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "rea-process-non-executable-"));
    const selected = join(root, "not-executable");
    try {
      await writeFile(selected, "not executable");
      await chmod(selected, 0o644);
      const failure = await runtimePathFailure({
        executable: selected,
        working_directory: root,
      });
      expect(projectAnalysisError(failure)).toMatchObject({
        code: "invalid_request",
        details: {
          issues: [
            {
              path: ["executable"],
              message: `executable could not be resolved: ${selected}; checked ${selected} (EACCES)`,
            },
          ],
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

const runtimePathFailure = async (
  scenario: Parameters<typeof parseProcessScenario>[0],
): Promise<AnalysisInputError> => {
  let failure: unknown;
  try {
    await resolveProcessScenarioRuntimePaths(parseProcessScenario(scenario));
  } catch (cause: unknown) {
    failure = cause;
  }
  expect(failure).toBeInstanceOf(AnalysisInputError);
  if (!(failure instanceof AnalysisInputError))
    throw new Error("Selected runtime path should be invalid input");
  return failure;
};
