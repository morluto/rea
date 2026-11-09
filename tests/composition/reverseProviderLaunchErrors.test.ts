import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { OwnedCommandFailure } from "../../src/process/OwnedCommand.js";
import {
  DarwinProcessOwnershipInspectionError,
  type DarwinCompilerOutcome,
} from "../../src/process/DarwinProcessRunTokenReader.js";
import {
  DARWIN_PROCESS_OWNERSHIP_REMEDIATION,
  LINUX_PROCESS_OWNERSHIP_REMEDIATION,
  LinuxOwnedProcessPrerequisiteError,
  createSystemProcessOwnershipHost,
  processOwnershipAdmissionRecovery,
  systemProcessOwnershipHost,
} from "../../src/process/ProcessOwnershipObservation.js";
import { ProcessAdmissionError } from "../../src/process/ProcessAdmissionError.js";
import {
  WindowsNativeAuthorityUnavailableError,
  type WindowsNativeAuthority,
} from "../../src/windows/WindowsNativeLoader.js";
import { WindowsOwnedProcess } from "../../src/windows/WindowsOwnedProcess.js";
import { AnalysisCapabilityUnavailableError } from "../../src/domain/analysisErrorCore.js";
import { projectAnalysisError } from "../../src/domain/analysisErrorProjection.js";
import {
  createArtifact,
  providerSnapshot,
} from "../support/reverseEngineeringCompositionFixtures.js";
import { TestReverseEngineeringService } from "../support/reverseEngineeringService.js";
import { awaitAcknowledgement } from "../fixtures/lifecycleAcknowledgement.js";

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

it.each(["EAGAIN", "EMFILE", "ENFILE", "ENOMEM"] as const)(
  "treats objdump host capacity spawn failure %s as retryable resource constraint without recording launch failure",
  async (code) => {
    const { directory, path } = await createArtifact();
    const command = resolve(directory, "configured-objdump");
    const hostFailure = Object.assign(
      new Error("controlled host capacity rejection"),
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
          throw new Error("Expected host capacity resource constraint failure");
        const projected = projectAnalysisError(result.error);
        expect(projected).toMatchObject({
          code: "resource_constraint",
          retryable: true,
          details: {
            resource: "capacity",
            reported_limits: {
              spawn_error: code,
              command,
            },
            diagnostics: {
              boundary: "host-capacity",
              command,
              system_code: code,
            },
          },
          remediation: {
            action: expect.stringContaining(
              "REA_OBJDUMP_COMMAND does not need to change",
            ),
          },
        });
        expect(projected.message).toContain(code);
        expect(projected.remediation.action).toContain(code);
      }
      expect(service.observedLaunchFailures()).toEqual({});
    } finally {
      await service.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it.each(["EAGAIN", "EMFILE", "ENFILE", "ENOMEM"] as const)(
  "treats rizin host capacity spawn failure %s as retryable resource constraint without recording launch failure",
  async (code) => {
    const { directory, path } = await createArtifact();
    const command = resolve(directory, "configured-rizin");
    const hostFailure = Object.assign(
      new Error("controlled host capacity rejection"),
      { code },
    );
    const service = new TestReverseEngineeringService({
      environment: { REA_RIZIN_COMMAND: command },
      runOwned: async () => {
        throw new OwnedCommandFailure("process", "launch failed", null, null, {
          cause: hostFailure,
        });
      },
    });
    try {
      const result = await service.executeRizinCommand({
        path,
        command: "iI",
      });
      if (result.ok)
        throw new Error(
          "Expected rizin host capacity resource constraint failure",
        );
      const projected = projectAnalysisError(result.error);
      expect(projected).toMatchObject({
        code: "resource_constraint",
        retryable: true,
        details: {
          resource: "capacity",
          reported_limits: {
            spawn_error: code,
            command,
          },
          diagnostics: {
            boundary: "host-capacity",
            command,
            system_code: code,
          },
        },
        remediation: {
          action: expect.stringContaining(
            "REA_RIZIN_COMMAND does not need to change",
          ),
        },
      });
      expect(projected.message).toContain(code);
      expect(projected.remediation.action).toContain(code);
      expect(service.observedLaunchFailures()).toEqual({});
    } finally {
      await service.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it.each(["EAGAIN", "EMFILE", "ENFILE", "ENOMEM"] as const)(
  "treats host capacity failure during ownership preparation (%s) as retryable resource constraint without recording launch failure",
  async (code) => {
    const { directory } = await createArtifact();
    const command = resolve(directory, "configured-objdump");
    const hostFailure = Object.assign(
      new Error("controlled ps host capacity rejection"),
      { code },
    );
    const prepareSpy = vi
      .spyOn(systemProcessOwnershipHost, "prepare")
      .mockRejectedValue(hostFailure);
    const service = new TestReverseEngineeringService({
      environment: { REA_OBJDUMP_COMMAND: command },
    });
    try {
      const result = await service.inspectWithObjdump({
        operation: "architectures",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        const projected = projectAnalysisError(result.error);
        expect(projected).toMatchObject({
          code: "resource_constraint",
          retryable: true,
          details: {
            resource: "capacity",
            diagnostics: {
              boundary: "host-capacity",
              system_code: code,
            },
          },
          remediation: {
            action: expect.stringContaining(
              "REA_OBJDUMP_COMMAND does not need to change",
            ),
          },
        });
        expect(projected.message).toContain(code);
        expect(projected.remediation.action).toContain(code);
      }
      expect(service.observedLaunchFailures()).toEqual({});
    } finally {
      prepareSpy.mockRestore();
      await service.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it.each(["EAGAIN", "EMFILE", "ENFILE", "ENOMEM"] as const)(
  "preserves host capacity when wrapped in LinuxOwnedProcessPrerequisiteError (%s) without recording launch failure",
  async (code) => {
    const { directory } = await createArtifact();
    const command = resolve(directory, "configured-objdump");
    const hostFailure = Object.assign(
      new Error("controlled ps host capacity rejection"),
      { code },
    );
    const prepareSpy = vi
      .spyOn(systemProcessOwnershipHost, "prepare")
      .mockRejectedValue(new LinuxOwnedProcessPrerequisiteError(hostFailure));
    const service = new TestReverseEngineeringService({
      environment: { REA_OBJDUMP_COMMAND: command },
    });
    try {
      const result = await service.inspectWithObjdump({
        operation: "architectures",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        const projected = projectAnalysisError(result.error);
        expect(projected).toMatchObject({
          code: "resource_constraint",
          retryable: true,
          details: {
            resource: "capacity",
            diagnostics: {
              boundary: "host-capacity",
              system_code: code,
            },
          },
          remediation: {
            action: expect.stringContaining(
              "REA_OBJDUMP_COMMAND does not need to change",
            ),
          },
        });
      }
      expect(service.observedLaunchFailures()).toEqual({});
    } finally {
      prepareSpy.mockRestore();
      await service.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it("preserves missing Linux ps prerequisite error without blaming configured command", async () => {
  const { directory } = await createArtifact();
  const command = resolve(directory, "configured-objdump");
  const psMissing = Object.assign(new Error("spawn ps ENOENT"), {
    code: "ENOENT",
  });
  const prepareSpy = vi
    .spyOn(systemProcessOwnershipHost, "prepare")
    .mockRejectedValue(new LinuxOwnedProcessPrerequisiteError(psMissing));
  const service = new TestReverseEngineeringService({
    environment: { REA_OBJDUMP_COMMAND: command },
  });
  try {
    const result = await service.inspectWithObjdump({
      operation: "architectures",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const projected = projectAnalysisError(result.error);
      expect(projected.code).toBe("capability_unavailable");
      expect(projected.details).toMatchObject({
        provider_id: "process-ownership",
      });
      expect(projected.message).toContain("procps-compatible ps");
      expect(projected.remediation.action).toContain(
        LINUX_PROCESS_OWNERSHIP_REMEDIATION,
      );
      expect(projected.remediation.action).not.toContain("REA_OBJDUMP_COMMAND");
    }
    expect(service.observedLaunchFailures()).toEqual({});
  } finally {
    prepareSpy.mockRestore();
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("preserves Darwin process ownership inspection preparation error without blaming objdump command", async () => {
  const { directory } = await createArtifact();
  const command = resolve(directory, "configured-objdump");
  const compilerOutcome: DarwinCompilerOutcome = {
    outcome: "exited",
    code: 1,
    signal: null,
    stderr:
      "xcrun: error: unable to find utility 'swiftc', not a developer tool or in PATH",
    stderrTruncated: false,
    outputTruncated: false,
    killed: false,
  };
  const darwinError = new DarwinProcessOwnershipInspectionError(
    "Swift compiler failed to build process reader helper",
    { compilerOutcome },
  );
  const prepareSpy = vi
    .spyOn(systemProcessOwnershipHost, "prepare")
    .mockRejectedValue(darwinError);
  const service = new TestReverseEngineeringService({
    environment: { REA_OBJDUMP_COMMAND: command },
  });
  try {
    const result = await service.inspectWithObjdump({
      operation: "architectures",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const projected = projectAnalysisError(result.error);
      expect(projected.code).toBe("capability_unavailable");
      expect(projected.details).toMatchObject({
        provider_id: "process-ownership",
      });
      expect(result.error.diagnostics).toMatchObject({
        boundary: "process-ownership",
        stage: "ownership_preparation",
        compiler_outcome: expect.objectContaining({
          outcome: "exited",
          code: 1,
        }),
      });
      expect(projected.message).toContain("Swift compiler failed");
      expect(projected.remediation.action).toContain(
        DARWIN_PROCESS_OWNERSHIP_REMEDIATION,
      );
      expect(projected.remediation.action).toContain(
        "REA_OBJDUMP_COMMAND does not need to change",
      );
    }
    expect(service.observedLaunchFailures()).toEqual({});
  } finally {
    prepareSpy.mockRestore();
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("preserves Darwin process ownership inspection error with cleanup state without blaming rizin command", async () => {
  const { directory, path } = await createArtifact();
  const command = resolve(directory, "configured-rizin");
  const cleanupError = new AnalysisCapabilityUnavailableError(
    "process-ownership",
    "close_binary",
    "staging cleanup failed",
    { cleanup: { reason: "rmdir failed", resources: ["/tmp/helper"] } },
  );
  const darwinError = new DarwinProcessOwnershipInspectionError(
    "Swift compiler failed to build process reader helper",
    { cleanupFailure: cleanupError },
  );
  const prepareSpy = vi
    .spyOn(systemProcessOwnershipHost, "prepare")
    .mockRejectedValue(darwinError);
  const service = new TestReverseEngineeringService({
    environment: { REA_RIZIN_COMMAND: command },
  });
  try {
    const result = await service.executeRizinCommand({
      path,
      command: "iI",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const projected = projectAnalysisError(result.error);
      expect(projected.code).toBe("cleanup_incomplete");
      expect(projected.details).toMatchObject({
        provider_id: "process-ownership",
      });
      expect(projected.remediation.action).toContain(
        DARWIN_PROCESS_OWNERSHIP_REMEDIATION,
      );
      expect(projected.remediation.action).toContain(
        "REA_RIZIN_COMMAND does not need to change",
      );
      expect(result.error.cleanupIncomplete).toBe(true);
      expect(result.error.cleanup).toMatchObject({
        reason: expect.stringContaining("staging cleanup failed"),
        resources: ["/tmp/helper"],
      });
    }
    // The helper's cleanup stays retained, and close retries it, until it
    // resolves.
    expect((await service.retryCleanup()).ok).toBe(false);
    cleanupError.resolveCleanup();
    expect(await service.retryCleanup()).toEqual({ ok: true, value: null });
    expect(service.observedLaunchFailures()).toEqual({});
  } finally {
    prepareSpy.mockRestore();
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("preserves command deadline timeout when macOS helper preparation aborts and cleanup fails", async () => {
  const { directory, path } = await createArtifact();
  const command = resolve(directory, "configured-objdump");
  const cleanupError = new AnalysisCapabilityUnavailableError(
    "process-ownership",
    "close_binary",
    "helper staging directory cleanup failed",
    { cleanup: { reason: "rmdir failed", resources: ["/tmp/helper"] } },
  );
  const darwinError = new DarwinProcessOwnershipInspectionError(
    "Darwin process ownership helper preparation was cancelled",
    {
      cancellation: { reason: "timeout" },
      cleanupFailure: cleanupError,
    },
  );
  const service = new TestReverseEngineeringService({
    environment: { REA_OBJDUMP_COMMAND: command },
    runOwned: async () => {
      throw new OwnedCommandFailure(
        "timeout",
        "Command deadline elapsed during ownership preparation.",
        null,
        null,
        {
          cause: darwinError,
          preparationFailure: darwinError,
        },
      );
    },
  });
  try {
    const result = await service.inspectWithObjdump({
      path,
      operation: "file_headers",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error._tag).toBe("AnalysisTimeoutError");
      const projected = projectAnalysisError(result.error);
      expect(projected.code).toBe("cleanup_incomplete");
      expect(result.error.cleanupIncomplete).toBe(true);
      expect(projected.remediation.action).toContain("command_timeout_ms");
      expect(projected.remediation.action).not.toContain("REA_OBJDUMP_COMMAND");
      expect(result.error.cleanup).toMatchObject({
        reason: expect.stringContaining(
          "helper staging directory cleanup failed",
        ),
        resources: ["/tmp/helper"],
      });
    }
    // The helper's cleanup stays retained, and close retries it, until it
    // resolves.
    expect((await service.retryCleanup()).ok).toBe(false);
    cleanupError.resolveCleanup();
    expect(await service.retryCleanup()).toEqual({ ok: true, value: null });
    expect(service.observedLaunchFailures()).toEqual({});
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("preserves command deadline timeout when macOS helper preparation aborts without cleanup failure", async () => {
  const { directory, path } = await createArtifact();
  const command = resolve(directory, "configured-objdump");
  const darwinError = new DarwinProcessOwnershipInspectionError(
    "Darwin process ownership helper preparation was cancelled",
    {
      cancellation: { reason: "timeout" },
    },
  );
  const service = new TestReverseEngineeringService({
    environment: { REA_OBJDUMP_COMMAND: command },
    runOwned: async () => {
      throw new OwnedCommandFailure(
        "timeout",
        "Command deadline elapsed during ownership preparation.",
        null,
        null,
        {
          cause: darwinError,
          preparationFailure: darwinError,
        },
      );
    },
  });
  try {
    const result = await service.inspectWithObjdump({
      path,
      operation: "file_headers",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error._tag).toBe("AnalysisTimeoutError");
      const projected = projectAnalysisError(result.error);
      expect(projected.code).toBe("provider_timeout");
      expect(result.error.cleanupIncomplete).toBe(false);
      expect(projected.remediation.action).toContain("command_timeout_ms");
      expect(projected.remediation.action).not.toContain("REA_OBJDUMP_COMMAND");
    }
    expect(service.observedLaunchFailures()).toEqual({});
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("uses platform-aware recovery without /proc when Darwin baseline capture rejects identity_snapshot_unavailable", async () => {
  const { directory } = await createArtifact();
  const command = resolve(directory, "configured-objdump");
  const platformSpy = vi
    .spyOn(systemProcessOwnershipHost, "platform", "get")
    .mockReturnValue("darwin");
  const captureSpy = vi
    .spyOn(systemProcessOwnershipHost, "captureBaseline")
    .mockRejectedValue(
      new ProcessAdmissionError("identity_snapshot_unavailable", {
        live_processes: 2,
      }),
    );
  const service = new TestReverseEngineeringService({
    environment: { REA_OBJDUMP_COMMAND: command },
  });
  try {
    const result = await service.inspectWithObjdump({
      operation: "architectures",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const projected = projectAnalysisError(result.error);
      expect(projected.code).toBe("capability_unavailable");
      expect(projected.details).toMatchObject({
        provider_id: "process-ownership",
        diagnostics: {
          boundary: "process-ownership",
          admission_code: "identity_snapshot_unavailable",
        },
      });
      expect(projected.details?.diagnostics).not.toHaveProperty("system_code");
      expect(projected.remediation.action).toContain(
        processOwnershipAdmissionRecovery(
          "identity_snapshot_unavailable",
          "darwin",
        ),
      );
      expect(projected.remediation.action).not.toContain("/proc");
      expect(projected.remediation.action).toContain(
        "REA_OBJDUMP_COMMAND does not need to change",
      );
    }
    expect(service.observedLaunchFailures()).toEqual({});
  } finally {
    captureSpy.mockRestore();
    platformSpy.mockRestore();
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("preserves Darwin baseline_unavailable admission failure without blaming configured command", async () => {
  const { directory } = await createArtifact();
  const command = resolve(directory, "configured-objdump");
  const platformSpy = vi
    .spyOn(systemProcessOwnershipHost, "platform", "get")
    .mockReturnValue("darwin");
  const psMissing = Object.assign(new Error("spawn ps ENOENT"), {
    code: "ENOENT",
    path: "ps",
    syscall: "spawn ps",
  });
  const captureSpy = vi
    .spyOn(systemProcessOwnershipHost, "captureBaseline")
    .mockRejectedValue(
      new ProcessAdmissionError("baseline_unavailable", undefined, {
        cause: psMissing,
      }),
    );
  const service = new TestReverseEngineeringService({
    environment: { REA_OBJDUMP_COMMAND: command },
  });
  try {
    const result = await service.inspectWithObjdump({
      operation: "architectures",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const projected = projectAnalysisError(result.error);
      expect(projected.code).toBe("capability_unavailable");
      expect(projected.details).toMatchObject({
        provider_id: "process-ownership",
        diagnostics: {
          boundary: "process-ownership",
          admission_code: "baseline_unavailable",
          system_code: "ENOENT",
        },
      });
      expect(projected.remediation.action).toContain(
        processOwnershipAdmissionRecovery("baseline_unavailable", "darwin"),
      );
      expect(projected.remediation.action).not.toContain("/proc");
      expect(projected.remediation.action).toContain(
        "REA_OBJDUMP_COMMAND does not need to change",
      );
    }
    expect(service.observedLaunchFailures()).toEqual({});
  } finally {
    captureSpy.mockRestore();
    platformSpy.mockRestore();
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("preserves provider-launch ENOENT when configured command path contains ps substring", async () => {
  const { directory } = await createArtifact();
  const command = resolve(directory, "apps", "objdump");
  const service = new TestReverseEngineeringService({
    environment: { REA_OBJDUMP_COMMAND: command },
  });
  try {
    const result = await service.inspectWithObjdump({
      operation: "architectures",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const projected = projectAnalysisError(result.error);
      expect(projected.code).toBe("capability_unavailable");
      expect(projected.details).toMatchObject({
        provider_id: "objdump.command",
        diagnostics: {
          boundary: "provider-launch",
          command,
          system_code: "ENOENT",
        },
      });
      expect(projected.remediation.action).toContain(
        "Set REA_OBJDUMP_COMMAND to an installed executable GNU objdump command",
      );
    }
    expect(service.observedLaunchFailures()).toMatchObject({
      inspect_with_objdump: {
        reason: expect.stringContaining(command),
        remediation: expect.stringContaining("REA_OBJDUMP_COMMAND"),
      },
    });
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it.each(["identity_snapshot_unavailable", "baseline_unavailable"] as const)(
  "preserves Linux process ownership admission failure in baseline capture (%s) without blaming objdump command",
  async (code) => {
    const { directory } = await createArtifact();
    const command = resolve(directory, "configured-objdump");
    const captureSpy = vi
      .spyOn(systemProcessOwnershipHost, "captureBaseline")
      .mockRejectedValue(
        new ProcessAdmissionError(
          code,
          code === "identity_snapshot_unavailable"
            ? { live_processes: 2 }
            : undefined,
        ),
      );
    const service = new TestReverseEngineeringService({
      environment: { REA_OBJDUMP_COMMAND: command },
    });
    try {
      const result = await service.inspectWithObjdump({
        operation: "architectures",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        const projected = projectAnalysisError(result.error);
        expect(projected.code).toBe("capability_unavailable");
        expect(projected.details).toMatchObject({
          provider_id: "process-ownership",
          diagnostics: {
            boundary: "process-ownership",
            admission_code: code,
          },
        });
        expect(projected.details?.diagnostics).not.toHaveProperty(
          "system_code",
        );
        expect(projected.message).toContain(code);
        expect(projected.remediation.action).toContain(
          processOwnershipAdmissionRecovery(code, "linux"),
        );
        expect(projected.remediation.action).toContain(
          "REA_OBJDUMP_COMMAND does not need to change",
        );
      }
      expect(service.observedLaunchFailures()).toEqual({});
    } finally {
      captureSpy.mockRestore();
      await service.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it("preserves Linux process ownership admission failure in baseline capture without blaming rizin command", async () => {
  const { directory, path } = await createArtifact();
  const command = resolve(directory, "configured-rizin");
  const captureSpy = vi
    .spyOn(systemProcessOwnershipHost, "captureBaseline")
    .mockRejectedValue(
      new ProcessAdmissionError("identity_snapshot_unavailable", {
        live_processes: 1,
      }),
    );
  const service = new TestReverseEngineeringService({
    environment: { REA_RIZIN_COMMAND: command },
  });
  try {
    const result = await service.executeRizinCommand({
      path,
      command: "iI",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const projected = projectAnalysisError(result.error);
      expect(projected.code).toBe("capability_unavailable");
      expect(projected.details).toMatchObject({
        provider_id: "process-ownership",
        diagnostics: {
          boundary: "process-ownership",
          admission_code: "identity_snapshot_unavailable",
        },
      });
      expect(projected.details?.diagnostics).not.toHaveProperty("system_code");
      expect(projected.message).toContain("identity_snapshot_unavailable");
      expect(projected.remediation.action).toContain(
        processOwnershipAdmissionRecovery(
          "identity_snapshot_unavailable",
          "linux",
        ),
      );
      expect(projected.remediation.action).toContain(
        "REA_RIZIN_COMMAND does not need to change",
      );
    }
    expect(service.observedLaunchFailures()).toEqual({});
  } finally {
    captureSpy.mockRestore();
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("restricts Linux process ownership prerequisite remediation to missing ps and preserves system error codes", async () => {
  const eioError = Object.assign(new Error("ps EIO"), { code: "EIO" });
  const psMissing = Object.assign(new Error("spawn ps ENOENT"), {
    code: "ENOENT",
  });
  const epermError = Object.assign(new Error("spawn ps EPERM"), {
    code: "EPERM",
  });

  let currentError: Error = eioError;
  const host = createSystemProcessOwnershipHost(
    "linux",
    {},
    {
      execFileOutput: async () => {
        throw currentError;
      },
    },
  );

  currentError = eioError;
  const eioFailure = (await host
    .captureBaseline?.()
    .catch((error: unknown) => error)) as LinuxOwnedProcessPrerequisiteError;
  expect(eioFailure).toBeInstanceOf(LinuxOwnedProcessPrerequisiteError);
  expect(eioFailure.remediationAction).toContain(
    processOwnershipAdmissionRecovery("baseline_unavailable", "linux", "EIO"),
  );
  expect(eioFailure.remediationAction).not.toContain("procps");
  expect(eioFailure.remediationAction).not.toContain("PATH");
  expect(eioFailure.diagnostics).toMatchObject({
    boundary: "process-ownership",
    system_code: "EIO",
  });

  currentError = epermError;
  const epermFailure = (await host
    .captureBaseline?.()
    .catch((error: unknown) => error)) as LinuxOwnedProcessPrerequisiteError;
  expect(epermFailure).toBeInstanceOf(LinuxOwnedProcessPrerequisiteError);
  expect(epermFailure.remediationAction).toContain(
    processOwnershipAdmissionRecovery("baseline_unavailable", "linux", "EPERM"),
  );
  expect(epermFailure.remediationAction).not.toContain("procps");
  expect(epermFailure.remediationAction).not.toContain("PATH");
  expect(epermFailure.diagnostics).toMatchObject({
    boundary: "process-ownership",
    system_code: "EPERM",
  });

  currentError = psMissing;
  const missingFailure = (await host
    .captureBaseline?.()
    .catch((error: unknown) => error)) as LinuxOwnedProcessPrerequisiteError;
  expect(missingFailure).toBeInstanceOf(LinuxOwnedProcessPrerequisiteError);
  expect(missingFailure.remediationAction).toContain(
    LINUX_PROCESS_OWNERSHIP_REMEDIATION,
  );
  expect(missingFailure.diagnostics).toMatchObject({
    boundary: "process-ownership",
    system_code: "ENOENT",
  });

  const noCodeError = new Error("ps failed with no error code");
  currentError = noCodeError;
  const noCodeFailure = (await host
    .captureBaseline?.()
    .catch((error: unknown) => error)) as LinuxOwnedProcessPrerequisiteError;
  expect(noCodeFailure).toBeInstanceOf(LinuxOwnedProcessPrerequisiteError);
  expect(noCodeFailure.reason).toContain(
    "could not obtain the process table using ps: ps failed with no error code",
  );
  expect(noCodeFailure.remediationAction).toContain(
    processOwnershipAdmissionRecovery("baseline_unavailable", "linux"),
  );
  expect(noCodeFailure.remediationAction).not.toContain("procps");
  expect(noCodeFailure.remediationAction).not.toContain("PATH");
  expect(noCodeFailure.diagnostics).toMatchObject({
    boundary: "process-ownership",
  });
  expect(noCodeFailure.diagnostics).not.toHaveProperty("system_code");

  const emptyTableHost = createSystemProcessOwnershipHost(
    "linux",
    {},
    {
      execFileOutput: async () => ({
        stdout: "    1     0     1     0 Ss   /sbin/init\n",
        stderr: "",
        stdoutBytes: 40,
        stderrBytes: 0,
      }),
    },
  );
  const unreportedFailure = (await emptyTableHost
    .prepare?.()
    .catch((error: unknown) => error)) as LinuxOwnedProcessPrerequisiteError;
  expect(unreportedFailure).toBeInstanceOf(LinuxOwnedProcessPrerequisiteError);
  expect(unreportedFailure.remediationAction).toContain(
    processOwnershipAdmissionRecovery("current_process_unreported", "linux"),
  );
  expect(unreportedFailure.diagnostics).toMatchObject({
    boundary: "process-ownership",
    admission_code: "current_process_unreported",
  });
  expect(unreportedFailure.diagnostics).not.toHaveProperty("system_code");
});

it.each(["EIO", "EPERM"] as const)(
  "preserves system error code (%s) on Linux baseline capture without blaming procps/PATH or objdump command",
  async (systemCode) => {
    const { directory } = await createArtifact();
    const command = resolve(directory, "configured-objdump");
    const systemError = Object.assign(new Error(`spawn ps ${systemCode}`), {
      code: systemCode,
      path: "ps",
      syscall: "spawn ps",
    });
    const captureSpy = vi
      .spyOn(systemProcessOwnershipHost, "captureBaseline")
      .mockRejectedValue(
        new LinuxOwnedProcessPrerequisiteError(systemError, systemCode),
      );
    const service = new TestReverseEngineeringService({
      environment: { REA_OBJDUMP_COMMAND: command },
    });
    try {
      const result = await service.inspectWithObjdump({
        operation: "architectures",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        const projected = projectAnalysisError(result.error);
        expect(projected.code).toBe("capability_unavailable");
        expect(projected.details).toMatchObject({
          provider_id: "process-ownership",
          diagnostics: {
            boundary: "process-ownership",
            system_code: systemCode,
          },
        });
        expect(projected.remediation.action).toContain(
          processOwnershipAdmissionRecovery(
            "baseline_unavailable",
            "linux",
            systemCode,
          ),
        );
        expect(projected.remediation.action).not.toContain("procps");
        expect(projected.remediation.action).not.toContain("PATH");
        expect(projected.remediation.action).not.toContain(
          "REA_OBJDUMP_COMMAND",
        );
      }
      expect(service.observedLaunchFailures()).toEqual({});
    } finally {
      captureSpy.mockRestore();
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

function createGate<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

it("preserves newer launch failure when older successful launch completes out of order and clears on newer recovery", async () => {
  const { directory } = await createArtifact();
  const command = resolve(directory, "failing-objdump");
  const call1Started = createGate<void>();
  const call1Release = createGate<void>();
  let callCount = 0;
  const service = new TestReverseEngineeringService({
    environment: { REA_OBJDUMP_COMMAND: command },
    runOwned: async () => {
      callCount++;
      const currentCall = callCount;
      if (currentCall === 1) {
        call1Started.resolve();
        await call1Release.promise;
        return providerSnapshot();
      }
      if (currentCall === 2) {
        throw new OwnedCommandFailure("process", "launch failed", null, null, {
          cause: Object.assign(new Error("missing executable"), {
            code: "ENOENT",
          }),
        });
      }
      return providerSnapshot();
    },
  });
  let call1Promise:
    | ReturnType<TestReverseEngineeringService["inspectWithObjdump"]>
    | undefined;
  try {
    expect(service.observedLaunchFailures()).toEqual({});

    call1Promise = service.inspectWithObjdump({
      operation: "architectures",
    });
    await awaitAcknowledgement(
      call1Started.promise,
      call1Promise,
      "provider command",
    );

    const call2Result = await service.inspectWithObjdump({
      operation: "architectures",
    });
    expect(call2Result.ok).toBe(false);
    expect(service.observedLaunchFailures()).toMatchObject({
      inspect_with_objdump: {
        reason: expect.stringContaining(command),
        remediation: expect.stringContaining("REA_OBJDUMP_COMMAND"),
      },
    });

    call1Release.resolve();
    const call1Result = await call1Promise;
    expect(call1Result.ok).toBe(true);

    // Call 1 succeeded with an older dispatch than call 2's failure; failure must not be cleared
    expect(service.observedLaunchFailures()).toMatchObject({
      inspect_with_objdump: {
        reason: expect.stringContaining(command),
        remediation: expect.stringContaining("REA_OBJDUMP_COMMAND"),
      },
    });

    const call3Result = await service.inspectWithObjdump({
      operation: "architectures",
    });
    expect(call3Result.ok).toBe(true);
    expect(service.observedLaunchFailures()).toEqual({});
  } finally {
    call1Release.resolve();
    if (call1Promise !== undefined) {
      await call1Promise.catch(() => {});
    }
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("ignores older launch failure when newer successful launch completes first and records newer failure", async () => {
  const { directory } = await createArtifact();
  const command = resolve(directory, "failing-objdump");
  const call1Started = createGate<void>();
  const call1Release = createGate<void>();
  let callCount = 0;
  const launchError = () =>
    new OwnedCommandFailure("process", "launch failed", null, null, {
      cause: Object.assign(new Error("missing executable"), {
        code: "ENOENT",
      }),
    });
  const service = new TestReverseEngineeringService({
    environment: { REA_OBJDUMP_COMMAND: command },
    runOwned: async () => {
      callCount++;
      const currentCall = callCount;
      if (currentCall === 1) {
        call1Started.resolve();
        await call1Release.promise;
        throw launchError();
      }
      if (currentCall === 2) {
        return providerSnapshot();
      }
      throw launchError();
    },
  });
  let call1Promise:
    | ReturnType<TestReverseEngineeringService["inspectWithObjdump"]>
    | undefined;
  try {
    expect(service.observedLaunchFailures()).toEqual({});

    call1Promise = service.inspectWithObjdump({
      operation: "architectures",
    });
    await awaitAcknowledgement(
      call1Started.promise,
      call1Promise,
      "provider command",
    );

    const call2Result = await service.inspectWithObjdump({
      operation: "architectures",
    });
    expect(call2Result.ok).toBe(true);
    expect(service.observedLaunchFailures()).toEqual({});

    call1Release.resolve();
    const call1Result = await call1Promise;
    expect(call1Result.ok).toBe(false);

    // Older failure must not clobber newer success
    expect(service.observedLaunchFailures()).toEqual({});

    const call3Result = await service.inspectWithObjdump({
      operation: "architectures",
    });
    expect(call3Result.ok).toBe(false);
    expect(service.observedLaunchFailures()).toMatchObject({
      inspect_with_objdump: {
        reason: expect.stringContaining(command),
        remediation: expect.stringContaining("REA_OBJDUMP_COMMAND"),
      },
    });
  } finally {
    call1Release.resolve();
    if (call1Promise !== undefined) {
      await call1Promise.catch(() => {});
    }
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("preserves provider-launch ENOENT for a real execute_rizin_command target and records launch failure", async () => {
  const { directory, path } = await createArtifact();
  const command = resolve(directory, "missing-rizin");
  const service = new TestReverseEngineeringService({
    environment: { REA_RIZIN_COMMAND: command },
  });
  try {
    const result = await service.executeRizinCommand({
      path,
      command: "iI",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const projected = projectAnalysisError(result.error);
      expect(projected.code).toBe("capability_unavailable");
      expect(projected.details).toMatchObject({
        provider_id: "rizin",
        diagnostics: {
          boundary: "provider-launch",
          command,
          system_code: "ENOENT",
        },
      });
      expect(projected.remediation.action).toContain(
        "Set REA_RIZIN_COMMAND to an installed executable Rizin command",
      );
    }
    expect(service.observedLaunchFailures()).toMatchObject({
      execute_rizin_command: {
        reason: expect.stringContaining(command),
        remediation: expect.stringContaining("REA_RIZIN_COMMAND"),
      },
    });
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("keeps Windows native runner load and self-test failures out of command-launch state", async () => {
  const { directory } = await createArtifact();
  const command = resolve(directory, "configured-objdump");
  const authorityError = new WindowsNativeAuthorityUnavailableError({
    available: false,
    failureStage: "self-test",
    retryable: true,
    reason: "REA Windows native self-test failed: Job Object assignment denied",
  });
  const service = new TestReverseEngineeringService({
    environment: { REA_OBJDUMP_COMMAND: command },
    runOwned: async () => {
      throw authorityError;
    },
  });
  try {
    const result = await service.inspectWithObjdump({
      operation: "architectures",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const projected = projectAnalysisError(result.error);
      expect(projected).toMatchObject({
        code: "capability_unavailable",
        retryable: true,
        details: {
          provider_id: "process-ownership",
          operation: "prepare_owned_process",
          diagnostics: {
            boundary: "process-ownership",
            control_code: "windows-native-authority-unavailable",
            failure_stage: "self-test",
          },
        },
      });
      expect(projected.remediation.action).toContain(
        "REA_OBJDUMP_COMMAND does not need to change",
      );
      expect(projected.remediation.action).not.toContain(
        "Set REA_OBJDUMP_COMMAND",
      );
    }
    expect(service.observedLaunchFailures()).toEqual({});
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

const fakeWindowsAuthority = (
  throwOnSpawn: () => Error,
): WindowsNativeAuthority => ({
  inspection: {
    abiVersion: 1,
    nodeApiVersion: 8,
    architecture: "x64",
    filesystem: {
      requestedPath: "C:\\probe",
      finalPath: "C:\\probe",
      filesystem: "NTFS",
      volumeSerial: "0".repeat(16),
      fileId: "0".repeat(32),
      size: 0,
      directory: true,
    },
    privateDacl: true,
    privateBridgeDescriptorAccess: true,
    atomicJobAssignment: true,
    killOnOwnerClose: true,
    protocolStdin: true,
    jobMemoryLimit: true,
  },
  call: (operation) => {
    if (operation === "process_spawn") throw throwOnSpawn();
    throw new Error(`Unmodeled native operation ${operation}`);
  },
});

it("keeps Windows process_spawn host-control rejections out of command-launch state while recording CreateProcessW executable failures", async () => {
  const { directory, path } = await createArtifact();
  const command = "C:\\tools\\llvm-objdump.exe";
  const rizinCommand = "C:\\tools\\rizin.exe";
  let spawnFailure: Error = Object.assign(
    new Error(
      `Caller CPU affinity cannot bound an owned process in another processor group [${command}] (Win32 87): The parameter is incorrect.`,
    ),
    {
      code: "ERR_REA_WINDOWS_NATIVE",
      constraint:
        "Caller CPU affinity cannot bound an owned process in another processor group",
      requestedPath: command,
      win32Code: 87,
    },
  );
  const authority = fakeWindowsAuthority(() => spawnFailure);
  const service = new TestReverseEngineeringService({
    environment: {
      REA_OBJDUMP_COMMAND: command,
      REA_RIZIN_COMMAND: rizinCommand,
    },
    runOwned: async (spawn) => {
      new WindowsOwnedProcess(
        spawn.command,
        spawn.arguments,
        spawn.cwd,
        spawn.env ?? {},
        spawn.windowsVerbatimArguments ?? false,
        { authority },
      );
      return providerSnapshot();
    },
  });
  try {
    const objdumpControlResult = await service.inspectWithObjdump({
      path,
      operation: "file_headers",
    });
    expect(objdumpControlResult.ok).toBe(false);
    if (!objdumpControlResult.ok) {
      const projected = projectAnalysisError(objdumpControlResult.error);
      expect(projected).toMatchObject({
        code: "capability_unavailable",
        retryable: true,
        details: {
          provider_id: "process-ownership",
          operation: "prepare_owned_process",
          diagnostics: {
            boundary: "process-ownership",
            control_code: "windows-native-spawn-control-unavailable",
            constraint:
              "Caller CPU affinity cannot bound an owned process in another processor group",
          },
        },
      });
      expect(projected.remediation.action).toContain(
        "REA_OBJDUMP_COMMAND does not need to change",
      );
      expect(projected.remediation.action).not.toContain(
        "Set REA_OBJDUMP_COMMAND",
      );
    }

    spawnFailure = Object.assign(
      new Error(
        `Suspended process has no owned Job Object membership [${rizinCommand}] (Win32 5): Access is denied.`,
      ),
      {
        code: "EACCES",
        constraint: "Suspended process has no owned Job Object membership",
        requestedPath: rizinCommand,
        win32Code: 5,
      },
    );
    const rizinControlResult = await service.executeRizinCommand({
      path,
      command: "iI",
    });
    expect(rizinControlResult.ok).toBe(false);
    if (!rizinControlResult.ok) {
      const projected = projectAnalysisError(rizinControlResult.error);
      expect(projected).toMatchObject({
        code: "capability_unavailable",
        retryable: true,
        details: {
          provider_id: "process-ownership",
          operation: "prepare_owned_process",
          diagnostics: {
            boundary: "process-ownership",
            control_code: "windows-native-spawn-control-unavailable",
            constraint: "Suspended process has no owned Job Object membership",
          },
        },
      });
      expect(projected.remediation.action).toContain(
        "REA_RIZIN_COMMAND does not need to change",
      );
      expect(projected.remediation.action).not.toContain(
        "Set REA_RIZIN_COMMAND",
      );
    }
    expect(service.observedLaunchFailures()).toEqual({});

    spawnFailure = Object.assign(
      new Error(
        `Create process atomically inside owned Job Object failed [${command}] (Win32 2): The system cannot find the file specified.`,
      ),
      {
        code: "ENOENT",
        constraint: "Create process atomically inside owned Job Object failed",
        requestedPath: command,
        win32Code: 2,
      },
    );
    const executableResult = await service.inspectWithObjdump({
      path,
      operation: "file_headers",
    });
    expect(executableResult.ok).toBe(false);
    if (!executableResult.ok) {
      const projected = projectAnalysisError(executableResult.error);
      expect(projected).toMatchObject({
        code: "capability_unavailable",
        details: {
          provider_id: "objdump.command",
          operation: "inspect_with_objdump",
          diagnostics: {
            boundary: "provider-launch",
            command,
            system_code: "ENOENT",
          },
        },
      });
    }
    expect(service.observedLaunchFailures()).toEqual({
      inspect_with_objdump: {
        reason: expect.stringContaining(JSON.stringify(command)),
        remediation: expect.stringContaining("REA_OBJDUMP_COMMAND"),
      },
    });
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});
