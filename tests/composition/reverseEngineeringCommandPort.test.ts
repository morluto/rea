import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { ReverseEngineeringService } from "../../src/application/reverse/ReverseEngineeringService.js";
import { analysisErrorProjectionSchema } from "../../src/contracts/errorSchemas.js";
import { projectAnalysisError } from "../../src/domain/analysisErrorProjection.js";
import { ok } from "../../src/domain/result.js";
import { createReverseEngineeringCommandPort } from "../../src/composition/reverseEngineering.js";
import type { runOwnedCommand } from "../../src/process/OwnedCommand.js";
import {
  fixtureCommandRepair,
  ownedLaunchRefusal,
  ownedOutput,
} from "../support/reverseEngineeringCompositionFixtures.js";

it("uses provider profiles supplied through the application port", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rea-reverse-port-"));
  const path = join(directory, "fixture.bin");
  await writeFile(path, Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  const run = vi.fn<typeof runOwnedCommand>(async () =>
    ownedOutput("injected"),
  );
  const service = new ReverseEngineeringService({
    environment: { REA_OBJDUMP_COMMAND: "ambient-objdump" },
    commands: {
      objdump: () =>
        ok({
          executable: "injected-objdump",
          arguments: ["--injected", path],
          repair: fixtureCommandRepair,
          identity: {
            id: "test.objdump",
            name: "Injected objdump",
            version: null,
          },
          environmentOverrides: { INJECTED_PROFILE: "yes" },
        }),
      rizin: () =>
        ok({
          executable: "injected-rizin",
          arguments: ["--injected", path],
          repair: fixtureCommandRepair,
          identity: { id: "test.rizin", name: "Injected Rizin", version: null },
        }),
    },
    runOwned: run,
  });

  try {
    const result = await service.inspectWithObjdump({
      path,
      operation: "file_headers",
    });
    expect(result.ok).toBe(true);
    const spawn = run.mock.calls[0]?.[0];
    expect(spawn?.command).toBe("injected-objdump");
    expect(spawn?.arguments).toEqual(["--injected", path]);
    expect(spawn?.env?.INJECTED_PROFILE).toBe("yes");
    if (result.ok) expect(result.value.provider.id).toBe("test.objdump");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("does not reintroduce ambient variables absent from the captured provider environment", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rea-reverse-env-"));
  const path = join(directory, "fixture.bin");
  const variable = "REA_TEST_LATE_PROVIDER_ENV";
  const previous = process.env[variable];
  await writeFile(path, Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  process.env[variable] = "late-ambient-value";
  const run = vi.fn<typeof runOwnedCommand>(async () =>
    ownedOutput("captured"),
  );
  const service = new ReverseEngineeringService({
    environment: { REA_OBJDUMP_COMMAND: "captured-objdump" },
    commands: {
      objdump: () =>
        ok({
          executable: "captured-objdump",
          arguments: [path],
          repair: fixtureCommandRepair,
          identity: {
            id: "test.objdump",
            name: "Captured objdump",
            version: null,
          },
          environmentOverrides: { PROFILE_VALUE: "explicit" },
        }),
      rizin: () =>
        ok({
          executable: "captured-rizin",
          arguments: [path],
          repair: fixtureCommandRepair,
          identity: { id: "test.rizin", name: "Captured Rizin", version: null },
        }),
    },
    runOwned: run,
  });

  try {
    await service.inspectWithObjdump({ path, operation: "file_headers" });
    expect(run.mock.calls[0]?.[0].env).toEqual({
      REA_OBJDUMP_COMMAND: "captured-objdump",
      PROFILE_VALUE: "explicit",
    });
  } finally {
    if (previous === undefined) delete process.env[variable];
    else process.env[variable] = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

it("projects missing and non-file objdump targets with actionable path reasons", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "rea-reverse-invalid-target-"),
  );
  const missing = join(directory, "missing.bin");
  const run = vi.fn(async () => ownedOutput());
  const service = new ReverseEngineeringService({
    commands: {
      objdump: () =>
        ok({
          executable: "unused-objdump",
          arguments: [missing],
          repair: fixtureCommandRepair,
          identity: {
            id: "test.objdump",
            name: "Test objdump",
            version: null,
          },
        }),
      rizin: ({ path }) =>
        ok({
          executable: "unused-rizin",
          arguments: [path],
          repair: fixtureCommandRepair,
          identity: { id: "test.rizin", name: "Test Rizin", version: null },
        }),
    },
    runOwned: run,
  });

  try {
    for (const [path, reason] of [
      [missing, "not found"],
      [directory, "not a regular file"],
    ] as const) {
      const result = await service.inspectWithObjdump({
        path,
        operation: "symbols",
      });
      if (result.ok) throw new Error("Expected target validation failure");
      const projection = projectAnalysisError(result.error);
      expect(analysisErrorProjectionSchema.safeParse(projection).success).toBe(
        true,
      );
      expect(projection).toMatchObject({
        code: "invalid_request",
        category: "invalid_input",
        retryable: false,
        message: expect.stringContaining(path),
        remediation: {
          action: expect.stringContaining("Correct the listed fields"),
        },
        details: {
          operation: "inspect_with_objdump",
          issues: [
            {
              path: ["path"],
              reason: "invalid_value",
              message: expect.stringContaining(reason),
            },
          ],
        },
      });
    }
    expect(run).not.toHaveBeenCalled();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("keeps target preflight I/O failures out of invalid-input classification", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "rea-reverse-target-io-failure-"),
  );
  const path = join(directory, "fixture.bin");
  await writeFile(path, Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  const ioFailure = Object.assign(new Error("device I/O failure"), {
    code: "EIO",
  });
  const stat = vi.fn(async () => {
    throw ioFailure;
  });
  const run = vi.fn(async () => ownedOutput());
  const service = new ReverseEngineeringService({
    stat,
    commands: {
      objdump: () =>
        ok({
          executable: "unused-objdump",
          arguments: [path],
          repair: fixtureCommandRepair,
          identity: {
            id: "test.objdump",
            name: "Test objdump",
            version: null,
          },
        }),
      rizin: () =>
        ok({
          executable: "unused-rizin",
          arguments: [path],
          repair: fixtureCommandRepair,
          identity: { id: "test.rizin", name: "Test Rizin", version: null },
        }),
    },
    runOwned: run,
  });

  try {
    const result = await service.inspectWithObjdump({
      path,
      operation: "symbols",
    });
    if (result.ok) throw new Error("Expected target preflight I/O failure");
    expect(result.error).toMatchObject({
      _tag: "ProviderAdapterError",
      cause: ioFailure,
      diagnostics: { phase: "target_preflight", system_code: "EIO" },
    });
    expect(projectAnalysisError(result.error)).toMatchObject({
      code: "execution_failure",
      category: "execution_failure",
      retryable: false,
      details: {
        provider_id: "test.objdump",
        operation: "inspect_with_objdump",
        diagnostics: { phase: "target_preflight", system_code: "EIO" },
      },
    });
    expect(run).not.toHaveBeenCalled();
    expect(stat).toHaveBeenCalledOnce();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it.each([
  { code: "ELOOP", reason: "symbolic-link loop" },
  { code: "ENAMETOOLONG", reason: "path is too long" },
])(
  "classifies selected target $code as correctable input",
  async ({ code, reason }) => {
    const directory = await mkdtemp(
      join(tmpdir(), "rea-reverse-target-path-error-"),
    );
    const path = join(directory, "fixture.bin");
    const pathFailure = Object.assign(new Error(`stat failed: ${code}`), {
      code,
    });
    const stat = vi.fn(async () => {
      throw pathFailure;
    });
    const run = vi.fn(async () => ownedOutput());
    const service = new ReverseEngineeringService({
      stat,
      commands: {
        objdump: () =>
          ok({
            executable: "unused-objdump",
            arguments: [path],
            repair: fixtureCommandRepair,
            identity: {
              id: "test.objdump",
              name: "Test objdump",
              version: null,
            },
          }),
        rizin: () =>
          ok({
            executable: "unused-rizin",
            arguments: [path],
            repair: fixtureCommandRepair,
            identity: { id: "test.rizin", name: "Test Rizin", version: null },
          }),
      },
      runOwned: run,
    });

    try {
      const result = await service.inspectWithObjdump({
        path,
        operation: "symbols",
      });
      if (result.ok) throw new Error(`Expected ${code} target path failure`);
      expect(result.error).toMatchObject({
        _tag: "AnalysisInputError",
        cause: pathFailure,
      });
      expect(projectAnalysisError(result.error)).toMatchObject({
        code: "invalid_request",
        category: "invalid_input",
        retryable: false,
        message: expect.stringContaining(path),
        details: {
          operation: "inspect_with_objdump",
          issues: [
            {
              path: ["path"],
              reason: "invalid_value",
              message: expect.stringContaining(reason),
            },
          ],
        },
      });
      expect(run).not.toHaveBeenCalled();
      expect(stat).toHaveBeenCalledOnce();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it.each([
  {
    operation: "inspect_with_objdump",
    environment: { PATH: "", REA_OBJDUMP_COMMAND: "rea-missing-objdump" },
    run: (service: ReverseEngineeringService, signal?: AbortSignal) =>
      service.inspectWithObjdump(
        { path: "artifact", operation: "file_headers" },
        signal === undefined ? {} : { signal },
      ),
    command: "rea-missing-objdump",
    reason: { lookup_failure: "not_found" },
  },
  {
    operation: "execute_rizin_command",
    environment: { PATH: "C:\\tools", PATHEXT: ".EXE;C:\\bad" },
    run: (service: ReverseEngineeringService, signal?: AbortSignal) =>
      service.executeRizinCommand(
        { path: "artifact", command: "i" },
        signal === undefined ? {} : { signal },
      ),
    command: "rizin",
    reason: { lookup_failure: "invalid_pathext", pathext_entry: "C:\\bad" },
  },
])(
  "refuses $operation on Windows when the bare command is not found on PATH, launching nothing",
  async ({ operation, environment, run: execute, command, reason }) => {
    const run = vi.fn(async () => ownedOutput());
    const service = new ReverseEngineeringService({
      environment,
      commands: createReverseEngineeringCommandPort(environment, "win32"),
      runOwned: run,
    });
    const result = await execute(service);
    if (result.ok) throw new Error("Expected a lookup refusal");
    const projection = projectAnalysisError(result.error);
    expect(analysisErrorProjectionSchema.safeParse(projection).success).toBe(
      true,
    );
    expect(projection).toMatchObject({
      code: "capability_unavailable",
      details: {
        operation,
        diagnostics: { boundary: "provider-lookup", command, ...reason },
      },
    });
    // Capability discovery reports the refusal and its repair, as it does
    // for a launch failure.
    expect(service.observedLaunchFailures()).toEqual({
      [operation]: {
        reason: projection.message,
        remediation: projection.remediation.action,
      },
    });
    // Cancellation is reported before the lookup refusal.
    const controller = new AbortController();
    const abortReason = new Error("caller stopped");
    controller.abort(abortReason);
    const cancelled = await execute(service, controller.signal);
    expect(cancelled).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisCancelledError", cause: abortReason },
    });
    expect(run).not.toHaveBeenCalled();
  },
);

it("reports a launch refusal with the repair the command port names", async () => {
  const profile = {
    executable: "fixture-command",
    arguments: [],
    repair: fixtureCommandRepair,
    identity: { id: "test.fixture", name: "Fixture", version: null },
  };
  const service = new ReverseEngineeringService({
    commands: { objdump: () => ok(profile), rizin: () => ok(profile) },
    runOwned: async (spawn) => {
      throw ownedLaunchRefusal("ENOENT", spawn.command);
    },
  });
  try {
    const result = await service.inspectWithObjdump({
      operation: "architectures",
    });
    if (result.ok) throw new Error("Expected a launch refusal");
    const projection = projectAnalysisError(result.error);
    expect(projection.message).toContain(
      'selected fixture executable "fixture-command"',
    );
    expect(projection.remediation.action).toBe(
      fixtureCommandRepair.remediationAction,
    );
    expect(service.observedLaunchFailures()).toEqual({
      inspect_with_objdump: {
        reason: projection.message,
        remediation: fixtureCommandRepair.remediationAction,
      },
    });
  } finally {
    await service.close();
  }
});
