import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

import { ArtifactFileCleanupFailure } from "../resources/ArtifactFileOperation.js";
import { ArtifactResourceScope } from "../resources/ArtifactResourceScope.js";
import { OwnedFileHandle } from "../filesystem/OwnedFileHandle.js";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { agentEnvInterpreter } from "./AgentEnvComputerHelper.js";

it("retains a failed runner descriptor close for retry by the caller", async () => {
  const directory = await createTestTempDirectory("rea-agentenv-close-");
  const path = join(directory, "agent-env");
  await writeFile(path, "#!/usr/bin/python3\n");
  const resources = new ArtifactResourceScope();
  const close = vi
    .spyOn(OwnedFileHandle.prototype, "close")
    .mockRejectedValueOnce(new Error("close denied"));
  try {
    let failure: unknown;
    try {
      await agentEnvInterpreter(
        { REA_AGENT_ENV_COMMAND: path },
        "desktop_build_doctor",
        resources,
      );
    } catch (cause: unknown) {
      failure = cause;
    }
    expect(failure).toBeInstanceOf(ArtifactFileCleanupFailure);
    expect(resources.cleanupResources).toContain(path);
    await resources.retryCleanup();
    expect(resources.cleanupResources).toEqual([]);
    // The reported failure shares the retained lease, so the retry resolves it.
    expect(
      failure instanceof ArtifactFileCleanupFailure &&
        failure.cleanupLease.released,
    ).toBe(true);
    close.mockRejectedValueOnce(new Error("close denied without scope"));
    let unscoped: unknown;
    try {
      await agentEnvInterpreter(
        { REA_AGENT_ENV_COMMAND: path },
        "check_build_task",
      );
    } catch (cause: unknown) {
      unscoped = cause;
    }
    expect(unscoped).toBeInstanceOf(ArtifactFileCleanupFailure);
    if (unscoped instanceof ArtifactFileCleanupFailure)
      await unscoped.cleanupLease.release();
  } finally {
    close.mockRestore();
    await resources.retryCleanup();
  }
});
