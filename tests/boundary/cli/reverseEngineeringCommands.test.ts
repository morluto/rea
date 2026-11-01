import pino from "pino";
import { Cli, z } from "incur";
import { afterEach, expect, it, vi } from "vitest";
import { rm } from "node:fs/promises";

import { registerReverseEngineeringCommands } from "../../../src/cli/reverseEngineeringCommands.js";
import { CLI_COMMANDS } from "../../../src/cliCommandNames.js";
import {
  AnalysisCancelledError,
  AnalysisTimeoutError,
  AnalysisOutputError,
} from "../../../src/domain/analysisErrorCore.js";
import {
  createEvidence,
  evidenceSchema,
} from "../../../src/domain/evidence.js";
import { err, ok } from "../../../src/domain/result.js";
import { RizinDebugSessionManager } from "../../../src/rizin/RizinDebugSessionManager.js";
import { closeOwnedDebuggerSessions } from "../../../src/process/ownedDebuggerSession.js";
import {
  DigestFileCleanupFailure,
  ReverseEngineeringService as CoreReverseEngineeringService,
} from "../../../src/application/reverse/ReverseEngineeringService.js";
import { createReverseEngineeringCommandPort } from "../../../src/composition/reverseEngineering.js";
import { OwnedCommandFailure } from "../../../src/process/OwnedCommand.js";
import type { ProviderProcessSupervisor } from "../../../src/process/ProviderProcess.js";
import {
  createArtifact,
  providerSnapshot,
} from "../../support/reverseEngineeringCompositionFixtures.js";
import type { CliInstance } from "../../../src/cli/types.js";
import type { ReverseEngineeringService } from "../../../src/application/reverse/ReverseEngineeringService.js";

const originalExitCode = process.exitCode;

afterEach(() => {
  process.exitCode = originalExitCode;
});

const observation = (completionStatus: "complete" | "unknown") =>
  createEvidence(
    undefined,
    { id: "gnu.objdump", name: "GNU objdump", version: null },
    {
      predicateType: "rea.reverse-engineering.command-observation",
      operation: "inspect_with_objdump",
      parameters: { operation: "file_headers" },
      result: { completion_status: completionStatus },
    },
  );

const runObjdump = async (
  service: Partial<ReverseEngineeringService>,
  path = "/tmp/sample",
  selection: { operation?: string; symbol?: string } = {},
) => {
  const commands = new Map<
    string,
    {
      run(input: {
        args: { path: string; operation: string };
        options: { followDebugLinks: boolean; symbol?: string };
      }): Promise<unknown>;
    }
  >();
  const cli = {
    command: (
      name: string,
      definition: {
        run(input: {
          args: { path: string; operation: string };
          options: { followDebugLinks: boolean; symbol?: string };
        }): Promise<unknown>;
      },
    ) => {
      commands.set(name, definition);
      return cli;
    },
  } as unknown as CliInstance;
  registerReverseEngineeringCommands(
    cli,
    pino({ enabled: false }),
    {},
    undefined,
    () => service as ReverseEngineeringService,
  );
  const command = commands.get(CLI_COMMANDS.inspectWithObjdump);
  if (command === undefined)
    throw new Error("objdump CLI command was not registered");
  return command.run({
    args: { path, operation: selection.operation ?? "file_headers" },
    options: {
      followDebugLinks: false,
      ...(selection.symbol === undefined ? {} : { symbol: selection.symbol }),
    },
  });
};

it("forwards the selected native symbol to the shared workflow", async () => {
  const inspectWithObjdump = vi.fn(async (_input: unknown) =>
    ok(observation("complete")),
  );
  await runObjdump(
    { inspectWithObjdump, close: async () => undefined },
    "/tmp/sample",
    { operation: "disassemble", symbol: "_Z3foov@@VERSION_1" },
  );
  expect(inspectWithObjdump.mock.calls[0]?.[0]).toEqual({
    path: "/tmp/sample",
    operation: "disassemble",
    follow_debug_links: false,
    symbol: "_Z3foov@@VERSION_1",
  });
});

it("lists objdump architectures without inventing an artifact path", async () => {
  const evidence = observation("complete");
  const inspectWithObjdump = vi.fn(async (_input: unknown) => ok(evidence));
  const commands = new Map<
    string,
    {
      readonly args?: { safeParse(input: unknown): { success: boolean } };
      run(input: { args?: unknown; options?: unknown }): Promise<unknown>;
    }
  >();
  const cli = {
    command: (_name: string, definition: unknown) => {
      commands.set(
        _name,
        definition as {
          readonly args?: {
            safeParse(input: unknown): { success: boolean };
          };
          run(input: { args?: unknown; options?: unknown }): Promise<unknown>;
        },
      );
      return cli;
    },
  } as unknown as CliInstance;
  registerReverseEngineeringCommands(
    cli,
    pino({ enabled: false }),
    {},
    undefined,
    () =>
      ({
        inspectWithObjdump,
        close: vi.fn(async () => undefined),
      }) as unknown as ReverseEngineeringService,
  );
  const command = commands.get(CLI_COMMANDS.listObjdumpArchitectures);
  if (command === undefined)
    throw new Error("architecture command was not registered");

  const result = await command.run({ options: { detail: "complete" } });

  expect(result).toEqual(evidence);
  expect(inspectWithObjdump).toHaveBeenCalledWith(
    { operation: "architectures" },
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  const artifactCommand = commands.get(CLI_COMMANDS.inspectWithObjdump);
  expect(
    artifactCommand?.args?.safeParse({
      path: "/tmp/sample",
      operation: "dwarf",
    }).success,
  ).toBe(true);
  expect(
    artifactCommand?.args?.safeParse({
      path: "/tmp/sample",
      operation: "architectures",
    }).success,
  ).toBe(false);
});

it("promotes only complete production cleanup-only Evidence after CLI cleanup retry", async () => {
  const { directory, path } = await createArtifact();
  const owner = {
    stop: vi.fn(async () => ({ status: "verified-cleanup" as const })),
  } as unknown as ProviderProcessSupervisor;
  const service = new CoreReverseEngineeringService({
    commands: createReverseEngineeringCommandPort({}),
    runOwned: vi.fn(async () => {
      throw new OwnedCommandFailure(
        "process",
        "Cleanup after process completion was incomplete.",
        providerSnapshot(),
        "provider process still running",
        undefined,
        ["owned-run"],
        owner,
      );
    }),
  });
  const inspect = service.inspectWithObjdump.bind(service);
  let producedCleanupFailure: AnalysisOutputError | undefined;
  let cleanupIncompleteBeforeClose: boolean | undefined;
  let completionBeforeClose: unknown;
  vi.spyOn(service, "inspectWithObjdump").mockImplementation(
    async (...args) => {
      const result = await inspect(...args);
      if (!result.ok && result.error instanceof AnalysisOutputError) {
        producedCleanupFailure = result.error;
        cleanupIncompleteBeforeClose = result.error.cleanupIncomplete;
        const partialEvidence = evidenceSchema.safeParse(
          result.error.partialObservation,
        );
        if (partialEvidence.success)
          completionBeforeClose = partialEvidence.data.normalized_result;
      }
      return result;
    },
  );

  try {
    const result = await runObjdump(service, path);

    expect(result).toMatchObject({
      provider: { id: "gnu.objdump" },
      normalized_result: { completion_status: "complete" },
    });
    expect(producedCleanupFailure?.cleanupOnly).toBe(true);
    expect(cleanupIncompleteBeforeClose).toBe(true);
    expect(completionBeforeClose).toMatchObject({
      completion_status: "complete",
    });
    expect(producedCleanupFailure).toMatchObject({
      cleanupIncomplete: false,
      cleanup: { resources: ["owned-run"] },
      partialObservation: {
        normalized_result: { completion_status: "complete" },
      },
    });
    expect(owner.stop).toHaveBeenCalledOnce();
  } finally {
    await service.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

it("preserves an operation timeout and unknown partial Evidence after cleanup retry", async () => {
  const { directory, path } = await createArtifact();
  const owner = {
    stop: vi.fn(async () => ({ status: "verified-cleanup" as const })),
  } as unknown as ProviderProcessSupervisor;
  const service = new CoreReverseEngineeringService({
    commands: createReverseEngineeringCommandPort({}),
    runOwned: vi.fn(async () => {
      throw new OwnedCommandFailure(
        "timeout",
        "Provider command timed out.",
        providerSnapshot({ exitCode: null }),
        "provider process still running",
        undefined,
        ["owned-run"],
        owner,
      );
    }),
  });
  let timeout: AnalysisTimeoutError | undefined;
  const inspect = service.inspectWithObjdump.bind(service);
  vi.spyOn(service, "inspectWithObjdump").mockImplementation(
    async (...args) => {
      const result = await inspect(...args);
      if (!result.ok && result.error instanceof AnalysisTimeoutError)
        timeout = result.error;
      return result;
    },
  );

  try {
    const result = await runObjdump(service, path);

    expect(result).toMatchObject({
      code: "provider_timeout",
      details: {
        partial_observation: {
          normalized_result: { completion_status: "unknown" },
        },
      },
    });
    expect(timeout).toBeInstanceOf(AnalysisTimeoutError);
    expect(timeout?.cleanupIncomplete).toBe(false);
    expect(owner.stop).toHaveBeenCalledOnce();
  } finally {
    await service.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

it("preserves an independent timeout after cleanup succeeds", async () => {
  const evidence = observation("unknown");
  const error = new AnalysisTimeoutError("inspect_with_objdump", 1_000, {
    cleanup: { reason: "first stop incomplete", resources: ["owned-run"] },
    partialObservation: evidence,
  });
  const service = {
    inspectWithObjdump: vi.fn(async () => err(error)),
    close: vi.fn(async () => {
      error.resolveCleanup();
    }),
  };

  const result = await runObjdump(service);

  expect(result).toMatchObject({
    code: "provider_timeout",
    details: {
      partial_observation: {
        normalized_result: { completion_status: "unknown" },
      },
    },
  });
  expect(error.cleanupIncomplete).toBe(false);
  expect((result as { details: unknown }).details).not.toHaveProperty(
    "cleanup",
  );
});

it("keeps a digest timeout primary when cancellation arrives during descriptor cleanup", async () => {
  const { directory, path } = await createArtifact();
  const controller = new AbortController();
  let ownerClosed = false;
  const owner = {
    resource: "artifact-descriptor:test",
    stop: vi.fn(async () =>
      ownerClosed
        ? { status: "not-owned" as const }
        : {
            status: "incomplete" as const,
            reason: "descriptor close remains pending",
          },
    ),
  };
  const timeout = Object.assign(new Error("digest timed out"), {
    code: "ETIMEDOUT",
  });
  let digestCalls = 0;
  const service = new CoreReverseEngineeringService({
    commands: createReverseEngineeringCommandPort({}),
    runOwned: vi.fn(async () => providerSnapshot()),
    digest: async () => {
      digestCalls += 1;
      if (digestCalls === 1) return "a".repeat(64);
      controller.abort(new Error("later caller cancellation"));
      throw new DigestFileCleanupFailure(timeout, owner as never);
    },
  });

  try {
    const result = await service.inspectWithObjdump(
      { path, operation: "file_headers" },
      { signal: controller.signal },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected the digest timeout");
    expect(result.error).toBeInstanceOf(AnalysisTimeoutError);
    expect(result.error.cleanupIncomplete).toBe(true);
    expect(result.error.cleanup?.resources).toEqual([
      "artifact-descriptor:test",
    ]);
  } finally {
    ownerClosed = true;
    await service.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

it("does not project cancellation cleanup as incomplete after a successful retry", async () => {
  const error = new AnalysisCancelledError("inspect_with_objdump", {
    cleanup: { reason: "first stop incomplete", resources: ["owned-run"] },
    partialObservation: observation("unknown"),
  });
  const service = {
    inspectWithObjdump: vi.fn(async () => err(error)),
    close: vi.fn(async () => {
      error.resolveCleanup();
    }),
  };

  const result = await runObjdump(service);

  expect(error.cleanupIncomplete).toBe(false);
  expect(result).toMatchObject({
    code: "cancelled",
    details: { cleanup: "complete" },
  });
});

it("returns cancellation with the completed observation when the caller interrupts service close", async () => {
  const evidence = observation("complete");
  const service = {
    inspectWithObjdump: vi.fn(async () => ok(evidence)),
    close: vi.fn(async () => {
      process.emit("SIGINT");
    }),
  };

  const result = await runObjdump(service);

  expect(result).toMatchObject({
    code: "cancelled",
    details: { partial_observation: evidence },
  });
  expect(process.exitCode).toBe(130);
});

it("runs an independent service for each command so cleanup cannot close later runs", async () => {
  const { directory, path } = await createArtifact();
  const commands = new Map<
    string,
    {
      run(input: {
        args: { path: string; operation: string };
        options: { followDebugLinks: boolean };
      }): Promise<unknown>;
    }
  >();
  const cli = {
    command: (
      name: string,
      definition: {
        run(input: {
          args: { path: string; operation: string };
          options: { followDebugLinks: boolean };
        }): Promise<unknown>;
      },
    ) => {
      commands.set(name, definition);
      return cli;
    },
  } as unknown as CliInstance;
  const created: ReverseEngineeringService[] = [];
  registerReverseEngineeringCommands(
    cli,
    pino({ enabled: false }),
    {},
    undefined,
    (environment = process.env) => {
      const service = new CoreReverseEngineeringService({
        environment,
        commands: createReverseEngineeringCommandPort(environment),
        runOwned: vi.fn(async () => providerSnapshot()),
      });
      created.push(service);
      return service;
    },
  );
  const command = commands.get(CLI_COMMANDS.inspectWithObjdump);
  if (command === undefined)
    throw new Error("objdump CLI command was not registered");
  const invoke = () =>
    command.run({
      args: { path, operation: "file_headers" },
      options: { followDebugLinks: false },
    });

  try {
    // The first run closes its own service; a repeated command must still run
    // instead of reporting that the service has been closed.
    expect(await invoke()).toMatchObject({ provider: { id: "gnu.objdump" } });
    expect(await invoke()).toMatchObject({ provider: { id: "gnu.objdump" } });
    expect(created).toHaveLength(2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("retains failed run services and settles their owners before another CLI launch", async () => {
  const { directory, path } = await createArtifact();
  const commands = new Map<string, { run(input: unknown): Promise<unknown> }>();
  const cli = {
    command: (
      name: string,
      definition: { run(input: unknown): Promise<unknown> },
    ) => {
      commands.set(name, definition);
      return cli;
    },
  } as unknown as CliInstance;
  let mayStop = false;
  const owner = {
    stop: vi.fn(async () =>
      mayStop
        ? { status: "verified-cleanup" as const }
        : { status: "incomplete" as const, reason: "writer still live" },
    ),
  } as unknown as ProviderProcessSupervisor;
  const createService = vi.fn(
    (environment = process.env) =>
      new CoreReverseEngineeringService({
        environment,
        commands: createReverseEngineeringCommandPort(environment),
        runOwned: async () => {
          throw new OwnedCommandFailure(
            "process",
            "cleanup incomplete",
            providerSnapshot(),
            "writer still live",
            undefined,
            ["owned-run"],
            owner,
          );
        },
      }),
  );
  registerReverseEngineeringCommands(
    cli,
    pino({ enabled: false }),
    {},
    undefined,
    createService,
  );
  const invoke = () =>
    commands.get(CLI_COMMANDS.inspectWithObjdump)!.run({
      args: { path, operation: "file_headers" },
      options: { followDebugLinks: false },
    });
  try {
    expect(await invoke()).toMatchObject({ code: "cleanup_incomplete" });
    expect(
      await commands
        .get(CLI_COMMANDS.executeRizinCommand)!
        .run({ args: { path, command: "iI" } }),
    ).toMatchObject({ code: "cleanup_incomplete" });
    expect(createService).toHaveBeenCalledTimes(1);
    mayStop = true;
    expect(await invoke()).toMatchObject({ provider: { id: "gnu.objdump" } });
    expect(createService).toHaveBeenCalledTimes(2);
    expect(owner.stop).toHaveBeenCalledTimes(4);
  } finally {
    mayStop = true;
    for (const result of createService.mock.results)
      if (result.type === "return") await result.value.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it.each([false, true])(
  "passes the Rizin TTY and uses final cleanup outcome (retry=%s)",
  async (retryClose) => {
    process.exitCode = 0;
    const commands = new Map<
      string,
      {
        run(input: {
          args: Record<string, unknown>;
          options: Record<string, unknown>;
        }): Promise<unknown>;
      }
    >();
    const cli = {
      command: (
        name: string,
        definition: {
          run(input: {
            args: Record<string, unknown>;
            options: Record<string, unknown>;
          }): Promise<unknown>;
        },
      ) => {
        commands.set(name, definition);
        return cli;
      },
    } as unknown as CliInstance;
    const evidence = createEvidence(
      undefined,
      { id: "rizin.debugger", name: "Rizin debugger", version: null },
      {
        predicateType: "rea.debugger.command-observation",
        operation: "rizin_debug_command",
        parameters: {
          session_id: "session-1",
          command: "dr",
          inferior_tty: "/dev/pts/7",
        },
        result: { output: "registers" },
        rawResult: { output: "registers" },
      },
    );
    const start = vi
      .spyOn(RizinDebugSessionManager.prototype, "start")
      .mockResolvedValue(ok({ session_id: "session-1", backend: null }));
    const execute = vi
      .spyOn(RizinDebugSessionManager.prototype, "execute")
      .mockResolvedValue(
        ok({
          evidence,
          result: {
            command: "dr",
            output: "registers",
            output_scope: "command_and_interleaved_session_output",
            output_truncated: false,
            completion_status: "complete",
            backend: null,
          },
        }),
      );
    vi.spyOn(RizinDebugSessionManager.prototype, "close").mockResolvedValue(
      retryClose
        ? err(
            new AnalysisOutputError(
              "close_rizin_debug_session",
              "first close incomplete",
              {
                cleanup: { reason: "retry pending", resources: ["session-1"] },
              },
            ),
          )
        : ok({ target_state: "unknown" }),
    );
    vi.spyOn(RizinDebugSessionManager.prototype, "closeAll").mockResolvedValue(
      undefined,
    );
    registerReverseEngineeringCommands(cli, pino({ enabled: false }), {});
    const command = commands.get(CLI_COMMANDS.debugWithRizin);
    if (command === undefined)
      throw new Error("Rizin CLI command was not registered");

    await command.run({
      args: { path: "./sample.bin", command: "dr" },
      options: { inferiorTty: "/dev/pts/7" },
    });

    expect(process.exitCode).toBe(0);
    expect(start).toHaveBeenCalledWith(
      { path: "./sample.bin", command: "dr", inferior_tty: "/dev/pts/7" },
      expect.any(AbortSignal),
    );
    expect(execute).toHaveBeenCalledWith(
      "session-1",
      "dr",
      expect.any(AbortSignal),
    );

    const parserCli = Cli.create("rea-test", { version: "1.0.0", sync: false });
    registerReverseEngineeringCommands(
      parserCli as unknown as CliInstance,
      pino({ enabled: false }),
      {},
    );
    const commandContract = Cli.toCommands
      .get(parserCli)
      ?.get(CLI_COMMANDS.debugWithRizin);
    expect(commandContract).toBeDefined();
    const argsSchema =
      commandContract === undefined
        ? undefined
        : Reflect.get(commandContract, "args");
    const optionsSchema =
      commandContract === undefined
        ? undefined
        : Reflect.get(commandContract, "options");
    if (
      !(argsSchema instanceof z.ZodObject) ||
      !(optionsSchema instanceof z.ZodObject)
    )
      throw new Error("Rizin CLI args/options schemas were not registered");
    expect(argsSchema.parse({ path: "./sample.bin", command: "dr" })).toEqual({
      path: "./sample.bin",
      command: "dr",
    });
    expect(optionsSchema.parse({ inferiorTty: "/dev/pts/7" })).toMatchObject({
      inferiorTty: "/dev/pts/7",
    });
  },
);

it.each(["incomplete", "interrupt", "control"] as const)(
  "reports final Rizin cleanup %s as a typed outcome",
  async (mode) => {
    const commands = new Map<
      string,
      { run(input: unknown): Promise<unknown> }
    >();
    const cli = {
      command(
        name: string,
        definition: { run(input: unknown): Promise<unknown> },
      ) {
        commands.set(name, definition);
        return cli;
      },
    } as unknown as CliInstance;
    const previous = process.exitCode;
    const evidence = createEvidence(
      undefined,
      { id: "rizin.debugger", name: "Rizin debugger", version: null },
      {
        predicateType: "rea.debugger.command-observation",
        operation: "rizin_debug_command",
        parameters: {
          session_id: "fixture-session",
          command: "dr",
          inferior_tty: "/dev/pts/7",
        },
        result: { output: "registers" },
        rawResult: { output: "registers" },
      },
    );
    const sessions = new Map([["fixture-session", { id: "fixture-session" }]]);
    vi.spyOn(RizinDebugSessionManager.prototype, "start").mockResolvedValue(
      ok({ session_id: "fixture-session", backend: null }),
    );
    const execute = vi
      .spyOn(RizinDebugSessionManager.prototype, "execute")
      .mockResolvedValue(
        ok({
          evidence,
          result: {
            command: "dr",
            output: "registers",
            output_scope: "command_and_interleaved_session_output",
            output_truncated: false,
            completion_status: "complete",
            backend: null,
          },
        }),
      );
    vi.spyOn(RizinDebugSessionManager.prototype, "close").mockImplementation(
      async () => {
        if (mode === "incomplete")
          return err(
            new AnalysisOutputError(
              "close_rizin_debug_session",
              "stop unconfirmed",
              {
                cleanup: {
                  reason: "stop unconfirmed",
                  resources: ["fixture-session"],
                },
              },
            ),
          );
        sessions.clear();
        return ok({ target_state: "unknown" });
      },
    );
    let abortedAtCleanupEnd = false;
    let signal: AbortSignal | undefined;
    const closeAll = vi
      .spyOn(RizinDebugSessionManager.prototype, "closeAll")
      .mockImplementation(async () => {
        signal = execute.mock.calls[0]?.[2];
        await new Promise<void>((resolve) =>
          setImmediate(() => {
            if (mode === "interrupt") process.emit("SIGINT");
            resolve();
          }),
        );
        abortedAtCleanupEnd = signal?.aborted === true;
        await closeOwnedDebuggerSessions(
          sessions,
          async () => ({ status: "incomplete", reason: "stop unconfirmed" }),
          "Rizin",
        );
      });
    registerReverseEngineeringCommands(cli, pino({ enabled: false }), {});
    const command = commands.get(CLI_COMMANDS.debugWithRizin);
    if (command === undefined)
      throw new Error("Rizin CLI command was not registered");
    try {
      process.exitCode = 0;
      const result = await command.run({
        args: { path: "./sample.bin", command: "dr" },
        options: { inferiorTty: "/dev/pts/7" },
      });
      expect(closeAll).toHaveBeenCalledOnce();
      if (mode === "control") {
        expect(result).toBe(evidence);
        expect(process.exitCode).toBe(0);
        expect(abortedAtCleanupEnd).toBe(false);
      } else if (mode === "interrupt") {
        expect(result).toMatchObject({
          code: "cancelled",
          details: {
            partial_observation: {
              operation: "rizin_debug_command",
              parameters: { session_id: "fixture-session" },
            },
          },
        });
        expect(process.exitCode).toBe(130);
        expect(abortedAtCleanupEnd).toBe(true);
      } else {
        expect(result).toMatchObject({
          code: "cleanup_incomplete",
          details: {
            cleanup: "incomplete",
            resources: ["fixture-session"],
            partial_observation: {
              operation: "rizin_debug_command",
              parameters: { session_id: "fixture-session" },
            },
          },
        });
        expect(sessions.size).toBe(1);
        expect(process.exitCode).toBe(1);
      }
    } finally {
      process.exitCode = previous;
      vi.restoreAllMocks();
    }
  },
);

it("reports concurrent CLI admission as retryable capacity and admits work after release", async () => {
  const { directory, path } = await createArtifact();
  const commands = new Map<string, { run(input: unknown): Promise<unknown> }>();
  const cli = {
    command: (
      name: string,
      definition: { run(input: unknown): Promise<unknown> },
    ) => {
      commands.set(name, definition);
      return cli;
    },
  } as unknown as CliInstance;
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const createService = vi.fn(
    (environment = process.env) =>
      new CoreReverseEngineeringService({
        environment,
        commands: createReverseEngineeringCommandPort(environment),
        runOwned: async () => {
          entered();
          await gate;
          return providerSnapshot();
        },
      }),
  );
  registerReverseEngineeringCommands(
    cli,
    pino({ enabled: false }),
    {},
    undefined,
    createService,
  );
  const invoke = () =>
    commands.get(CLI_COMMANDS.inspectWithObjdump)!.run({
      args: { path, operation: "file_headers" },
      options: { followDebugLinks: false },
    });
  const running = invoke();
  try {
    await started;
    expect(await invoke()).toMatchObject({
      code: "resource_constraint",
      retryable: true,
      remediation: {
        action:
          "Wait for an active analysis to complete, then retry within the reported admission limits.",
      },
      details: { resource: "capacity" },
    });
    expect(createService).toHaveBeenCalledTimes(1);
    release();
    expect(await running).toMatchObject({ provider: { id: "gnu.objdump" } });
    expect(await invoke()).toMatchObject({ provider: { id: "gnu.objdump" } });
    expect(createService).toHaveBeenCalledTimes(2);
  } finally {
    release();
    await running;
    await rm(directory, { recursive: true, force: true });
  }
});
