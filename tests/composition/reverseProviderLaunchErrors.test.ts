import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { OwnedCommandFailure } from "../../src/process/OwnedCommand.js";
import { projectAnalysisError } from "../../src/domain/analysisErrorProjection.js";
import {
  createArtifact,
  providerSnapshot,
} from "../support/reverseEngineeringCompositionFixtures.js";
import { TestReverseEngineeringService } from "../support/reverseEngineeringService.js";

it.each(["ENOENT", "EACCES", "EPERM", "ENOTDIR"] as const)(
  "preserves provider-launch %s and executable recovery independently of target admission",
  async (code) => {
    const { directory, path } = await createArtifact();
    const command = resolve(directory, "configured-objdump");
    const hostFailure = Object.assign(
      new Error("controlled executable launch rejection"),
      { code },
    );
    const service = new TestReverseEngineeringService({
      environment: { REA_OBJDUMP_COMMAND: command },
      runOwned: async () => {
        throw new OwnedCommandFailure("process", "launch failed", null, null, {
          cause: hostFailure,
        });
      },
    });
    try {
      for (const input of [
        { operation: "architectures" },
        { path, operation: "file_headers" },
      ]) {
        const result = await service.inspectWithObjdump(input);
        if (result.ok)
          throw new Error("Expected configured provider launch failure");
        const projected = projectAnalysisError(result.error);
        expect(projected).toMatchObject({
          code: "capability_unavailable",
          retryable: false,
          details: {
            provider_id: "objdump.command",
            diagnostics: {
              boundary: "provider-launch",
              command,
              system_code: code,
            },
          },
          remediation: {
            action: expect.stringContaining("REA_OBJDUMP_COMMAND"),
          },
        });
        expect(projected.message).toContain(command);
        expect(projected.message).toContain(code);
        expect(projected.remediation.action).toContain("execute permission");
        expect(projected.remediation.action).not.toContain("another target");
      }
    } finally {
      await service.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it("preserves target-read permission diagnostics before provider launch", async () => {
  let launches = 0;
  const path = resolve("read-denied-artifact");
  const service = new TestReverseEngineeringService({
    stat: async () => {
      throw Object.assign(new Error("controlled target read denial"), {
        code: "EACCES",
      });
    },
    runOwned: async () => {
      launches += 1;
      return providerSnapshot();
    },
  });
  try {
    const result = await service.inspectWithObjdump({
      path,
      operation: "file_headers",
    });
    if (result.ok) throw new Error("Expected target admission failure");
    expect(projectAnalysisError(result.error)).toMatchObject({
      code: "access_denied",
      details: { boundary: "filesystem-read", path, system_code: "EACCES" },
    });
    expect(launches).toBe(0);
  } finally {
    await service.close();
  }
});

it("retains successful architecture and artifact output for an admitted provider", async () => {
  const { directory, path } = await createArtifact();
  const service = new TestReverseEngineeringService({
    runOwned: async () => providerSnapshot(),
  });
  try {
    for (const input of [
      { operation: "architectures" },
      { path, operation: "file_headers" },
    ]) {
      const result = await service.inspectWithObjdump(input);
      if (!result.ok) throw result.error;
      expect(result.value.normalized_result).toMatchObject({
        stdout: "captured owned output",
        completion_status: "complete",
      });
    }
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("tracks observed launch failures and clears them after subsequent successful launch", async () => {
  const { directory, path } = await createArtifact();
  const command = resolve(directory, "failing-objdump");
  let failLaunch = true;
  const service = new TestReverseEngineeringService({
    environment: { REA_OBJDUMP_COMMAND: command },
    runOwned: async () => {
      if (failLaunch) {
        throw new OwnedCommandFailure("process", "launch failed", null, null, {
          cause: Object.assign(new Error("missing executable"), {
            code: "ENOENT",
          }),
        });
      }
      return providerSnapshot();
    },
  });
  try {
    expect(service.observedLaunchFailures()).toEqual({});
    const failed = await service.inspectWithObjdump({
      operation: "architectures",
    });
    expect(failed.ok).toBe(false);
    expect(service.observedLaunchFailures()).toMatchObject({
      inspect_with_objdump: {
        reason: expect.stringContaining(command),
        remediation: expect.stringContaining("REA_OBJDUMP_COMMAND"),
      },
    });

    failLaunch = false;
    const succeeded = await service.inspectWithObjdump({
      operation: "architectures",
    });
    expect(succeeded.ok).toBe(true);
    expect(service.observedLaunchFailures()).toEqual({});
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});
