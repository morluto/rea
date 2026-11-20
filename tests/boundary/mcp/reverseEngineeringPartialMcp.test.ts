import pino from "pino";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, it, vi } from "vitest";

import { TestReverseEngineeringService as ReverseEngineeringService } from "../../support/reverseEngineeringService.js";
import {
  ownedFailure,
  ownedOutput,
} from "../../support/reverseEngineeringCompositionFixtures.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
} from "../../../src/domain/analysisErrorCore.js";
import type { FridaDeviceList } from "../../../src/domain/fridaDiscovery.js";
import {
  createBinarySessionTargets,
  createCacheProvider,
  createTestBinarySession,
} from "../../fixtures/binarySession.js";
import type { AnalysisOperationPort } from "../../../src/ports/AnalysisProvider.js";
import { EvidenceIntegrityError } from "../../../src/domain/evidenceErrors.js";
import { err, ok } from "../../../src/domain/result.js";
import type { WithAdmittedAnalysis } from "../../../src/server/analysisAdmission.js";
import { createToolResultDelivery } from "../../../src/server/toolResult.js";
import { EvidenceMcpServer } from "../../../src/server/EvidenceMcpServer.js";
import { mcpTest } from "../../support/mcp/mcpFixture.js";
import {
  createReverseEngineeringMcpHarness,
  invokeWithLiveSignal,
  registerReverseEngineeringTools,
} from "../../support/reverseEngineeringMcpHarness.js";

const createTimedOutRizinService = (): ReverseEngineeringService =>
  new ReverseEngineeringService({
    runOwned: async () => {
      throw ownedFailure(
        "timeout",
        ownedOutput("partial provider output", "", { exitCode: null }),
      );
    },
  });

mcpTest(
  "keeps a non-Evidence partial with a caller-selected evidence_id inline over MCP",
  async ({ mcp }) => {
    const partial = {
      devices: [],
      cleanup_error: null,
      evidence_id: "caller-selected",
    };
    const observation: FridaDeviceList = partial;
    const failure = new AnalysisCancelledError("inspect_with_objdump", {
      cause: new Error("cancel inspection"),
      partialObservation: observation,
    });
    const service = new ReverseEngineeringService();
    vi.spyOn(service, "inspectWithObjdump").mockResolvedValue(err(failure));
    const recordEvidence = vi.fn(() => ok("added" as const));
    const server = new EvidenceMcpServer(
      { name: "reverse-partial-observation", version: "1" },
      {},
      recordEvidence,
      createToolResultDelivery(undefined),
    );
    registerReverseEngineeringTools(server, service, {
      recordEvidence,
    });

    const client = await mcp.connect(server);
    const result = await client.callTool({
      name: "inspect_with_objdump",
      arguments: { path: "package.json", operation: "file_headers" },
    });
    const projected = parseMcpToolError(result);
    expect(projected.error).toMatchObject({
      code: "cancelled",
      details: { operation: "inspect_with_objdump" },
    });
    expect(projected.error.details?.partial_observation).toEqual(partial);
    expect(result.structuredContent).toBeUndefined();
    expect(recordEvidence).not.toHaveBeenCalled();
    expect(result._meta).toEqual({
      provenance: { untrusted_content: true, source: "analysis_target" },
    });
  },
);

it("records partial Evidence and references it in the original MCP error", async () => {
  const { server, handler } = createReverseEngineeringMcpHarness();
  const service = createTimedOutRizinService();
  const recordEvidence = vi.fn(() => ok("added" as const));
  registerReverseEngineeringTools(server, service, {
    recordEvidence,
  });
  const invoke = handler("execute_rizin_command");

  const response = (await invokeWithLiveSignal(invoke, {
    path: "package.json",
    command: "iI",
  })) as {
    readonly isError?: boolean;
    readonly structuredContent?: {
      readonly error?: {
        readonly details?: Readonly<Record<string, unknown>>;
      };
    };
  };

  expect(response.isError).toBe(true);
  expect(recordEvidence).toHaveBeenCalledTimes(1);
  expect(response.structuredContent?.error?.details).toMatchObject({
    partial_observation: {
      kind: "retained-evidence",
      evidence_id: expect.any(String),
    },
  });
});

it("admits Rizin mutation before dispatch", async () => {
  const { server, handler } = createReverseEngineeringMcpHarness();
  const events: string[] = [];
  const service = new ReverseEngineeringService({
    runOwned: async () => {
      events.push("dispatch");
      return ownedOutput("rizin output");
    },
  });
  registerReverseEngineeringTools(server, service, {
    session: {
      withAdmittedExternalMutation: async (_path, _signal, operation) => {
        events.push("admit");
        return ok(await operation());
      },
    },
  });
  const invoke = handler("execute_rizin_command");

  await invoke(
    { path: "package.json", command: "iI" },
    { mcpReq: { signal: new AbortController().signal } },
  );

  expect(events).toEqual(["admit", "dispatch"]);
});

it("refuses a Rizin command before admission while inspection cleanup still fails", async () => {
  const { server, handler } = createReverseEngineeringMcpHarness();
  const cleanup = new AnalysisInputError("execute_rizin_command");
  const executeRizinCommandValidated = vi.fn();
  const service = {
    retryCleanup: async () => err(cleanup),
    executeRizinCommandValidated,
  } as unknown as ReverseEngineeringService;
  const withAdmittedExternalMutation = vi.fn();
  registerReverseEngineeringTools(server, service, {
    session: { withAdmittedExternalMutation },
  });
  const invoke = handler("execute_rizin_command");

  const response = (await invokeWithLiveSignal(invoke, {
    path: "package.json",
    command: "iI",
  })) as CallToolResult;

  expect(response.isError).toBe(true);
  expect(withAdmittedExternalMutation).not.toHaveBeenCalled();
  expect(executeRizinCommandValidated).not.toHaveBeenCalled();
});

it("refuses malformed Rizin input before admission", async () => {
  const { server, handler } = createReverseEngineeringMcpHarness();
  const executeRizinCommandValidated = vi.fn();
  const service = {
    retryCleanup: async () => ok(null),
    executeRizinCommandValidated,
  } as unknown as ReverseEngineeringService;
  const withAdmittedExternalMutation = vi.fn();
  registerReverseEngineeringTools(server, service, {
    session: { withAdmittedExternalMutation },
  });
  const invoke = handler("execute_rizin_command");

  const response = (await invokeWithLiveSignal(invoke, {
    path: "package.json",
  })) as CallToolResult;

  expect(parseMcpToolError(response).error).toMatchObject({
    code: "invalid_request",
    details: {
      issues: [
        { path: ["command"], reason: "missing_argument", expected: "string" },
      ],
    },
  });
  expect(executeRizinCommandValidated).not.toHaveBeenCalled();
  expect(withAdmittedExternalMutation).not.toHaveBeenCalled();
});

it("delivers failed Rizin execution after external admission", async () => {
  const { server, handler } = createReverseEngineeringMcpHarness();
  const service = new ReverseEngineeringService({
    runOwned: async () => {
      throw new Error("Rizin command failed");
    },
  });
  registerReverseEngineeringTools(server, service, {
    session: {
      withAdmittedExternalMutation: async (_path, _signal, operation) =>
        ok(await operation()),
    },
  });
  const invoke = handler("execute_rizin_command");

  const response = (await invokeWithLiveSignal(invoke, {
    path: "package.json",
    command: "iI",
  })) as { readonly isError?: boolean };

  expect(response.isError).toBe(true);
});

it("preserves the Rizin operation error when analysis retirement also fails", async () => {
  const { server, handler } = createReverseEngineeringMcpHarness();
  const reason = { stage: "operation-input" };
  const primary = new AnalysisInputError("execute_rizin_command", {
    cause: reason,
  });
  const retirement = new AnalysisInputError("rebind");
  const service = {
    retryCleanup: async () => ok(null),
    executeRizinCommandValidated: async () => err(primary),
  } as unknown as ReverseEngineeringService;
  const observedOperationResult = vi.fn();
  registerReverseEngineeringTools(server, service, {
    session: {
      withAdmittedExternalMutation: async (
        _path,
        _signal,
        operation,
        rebindFailure,
      ) => {
        const result = await operation();
        observedOperationResult(result);
        return err(rebindFailure(result, retirement));
      },
    },
  });
  const invoke = handler("execute_rizin_command");

  const response = (await invoke(
    { path: "package.json", command: "iI" },
    { mcpReq: { signal: new AbortController().signal } },
  )) as {
    readonly isError?: boolean;
    readonly structuredContent?: {
      readonly error?: {
        readonly code?: string;
        readonly details?: { readonly reason?: string };
      };
    };
  };

  expect(primary.cause).toBe(reason);
  expect(primary.secondaryFailures).toEqual([retirement]);
  expect(response.isError).toBe(true);
  expect(observedOperationResult).toHaveBeenCalledWith(
    expect.objectContaining({ ok: false }),
  );
  expect(response.structuredContent?.error).toMatchObject({
    code: "invalid_request",
  });
});

it.each(["success", "timeout"])(
  "retains %s output and requires reopening after a symlink command",
  async (outcome) => {
    const [target] = await createBinarySessionTargets();
    const alias = join(dirname(target), "active-target-alias.hop");
    await symlink(target, alias);
    const session = createTestBinarySession(createCacheProvider([]));
    expect((await session.open(target)).ok).toBe(true);
    expect(session.activeTarget()?.path).toBe(target);
    const originalDigest = session.activeTarget()?.sha256;
    expect(originalDigest).toEqual(expect.any(String));

    const { server, handler } = createReverseEngineeringMcpHarness();
    const service = new ReverseEngineeringService({
      runOwned: async () => {
        await writeFile(alias, "changed by Rizin");
        if (outcome === "timeout")
          throw ownedFailure(
            "timeout",
            ownedOutput("partial analysis output", "timeout diagnostics", {
              exitCode: null,
            }),
          );
        return ownedOutput("partial analysis output");
      },
    });
    const recordEvidence = vi.fn(() => ok("added" as const));
    registerReverseEngineeringTools(server, service, {
      recordEvidence,
      session,
    });
    const invoke = handler("execute_rizin_command");

    const response = (await invoke(
      { path: alias, command: "wx 00 @ 0" },
      { mcpReq: { signal: new AbortController().signal } },
    )) as {
      readonly isError?: boolean;
      readonly structuredContent?: {
        readonly error?: {
          readonly code?: string;
          readonly details?: Readonly<Record<string, unknown>>;
        };
      };
    };

    expect(response.isError ?? false).toBe(outcome === "timeout");
    if (outcome === "timeout") {
      expect(response.structuredContent?.error?.code).toBe("provider_timeout");
      expect(response.structuredContent?.error?.details).toMatchObject({
        captured_output: {
          stdout: "partial analysis output",
          stderr: "timeout diagnostics",
        },
      });
      expect(response.structuredContent?.error?.details).toMatchObject({
        partial_observation: {
          kind: "retained-evidence",
          evidence_id: expect.any(String),
        },
      });
    }
    expect(recordEvidence).toHaveBeenCalledTimes(1);
    expect(session.activeTarget()).toBeUndefined();
    expect((await session.execute("address_name", {})).ok).toBe(false);
    expect((await session.open(target)).ok).toBe(true);
    expect(session.activeTarget()?.sha256).toEqual(expect.any(String));
    expect(session.activeTarget()?.sha256).not.toBe(originalDigest);
    await session.close();
    await rm(dirname(target), { recursive: true, force: true });
  },
);

it("preserves a partial MCP error without claiming failed Evidence retention", async () => {
  const { server, handler } = createReverseEngineeringMcpHarness();
  const service = createTimedOutRizinService();
  const recordEvidence = vi.fn((_evidence: unknown) =>
    err(new EvidenceIntegrityError("retention failed")),
  );
  registerReverseEngineeringTools(server, service, {
    recordEvidence,
  });
  const invoke = handler("execute_rizin_command");

  const response = (await invokeWithLiveSignal(invoke, {
    path: "package.json",
    command: "iI",
  })) as {
    readonly isError?: boolean;
    readonly structuredContent?: {
      readonly error?: {
        readonly details?: Readonly<Record<string, unknown>>;
      };
    };
  };

  expect(response.isError).toBe(true);
  expect(response.structuredContent?.error?.details).toMatchObject({
    partial_observation: {
      kind: "inline-evidence",
      retention: "unknown",
      evidence: { operation: "execute_rizin_command" },
    },
  });
  expect(
    JSON.stringify(response.structuredContent?.error?.details),
  ).not.toContain("retained-evidence");
});

it("delivers pathless objdump capability Evidence and input errors through its named tool", async () => {
  const { server, handler } = createReverseEngineeringMcpHarness();
  const service = new ReverseEngineeringService({
    runOwned: async () => ownedOutput("objdump output"),
  });
  const delivery = createToolResultDelivery(2 * 1024 * 1024);
  registerReverseEngineeringTools(server, service);
  const context = { mcpReq: { signal: new AbortController().signal } };
  const objdump = handler("inspect_with_objdump");
  const rizin = handler("execute_rizin_command");

  const success = (await objdump(
    { path: "package.json", operation: "file_headers" },
    context,
  )) as { readonly isError?: boolean };
  const architectures = (await objdump(
    { operation: "architectures" },
    context,
  )) as {
    readonly isError?: boolean;
  };
  const objdumpFailure = (await objdump({}, context)) as {
    readonly isError?: boolean;
  };
  const failure = (await rizin({}, context)) as {
    readonly isError?: boolean;
    readonly structuredContent?: {
      readonly error?: { readonly code?: string };
    };
  };
  const cancelled = new AbortController();
  cancelled.abort();
  const cancelledContext = { mcpReq: { signal: cancelled.signal } };
  const cancelledObjdump = (await objdump(
    { path: "package.json", operation: "file_headers" },
    cancelledContext,
  )) as { readonly isError?: boolean };
  const cancelledRizin = (await rizin(
    { path: "package.json", command: "iI" },
    cancelledContext,
  )) as { readonly isError?: boolean };

  expect(success.isError).not.toBe(true);
  expect(architectures.isError).not.toBe(true);
  expect(objdumpFailure.isError).toBe(true);
  expect(failure.isError).toBe(true);
  expect(cancelledObjdump.isError).toBe(true);
  expect(cancelledRizin.isError).toBe(true);
});

it("does not treat a malformed partial observation as retained Evidence", async () => {
  const { server, handler } = createReverseEngineeringMcpHarness();
  const invalidError = Object.assign(
    new AnalysisInputError("execute_rizin_command"),
    { partialObservation: { evidence_id: 42 } },
  );
  const service = {
    inspectWithObjdump: async () => err(invalidError),
    retryCleanup: async () => ok(null),
    executeRizinCommandValidated: async () => err(invalidError),
  } as unknown as ReverseEngineeringService;
  const recordEvidence = vi.fn(() => ok("added" as const));
  registerReverseEngineeringTools(server, service, {
    recordEvidence,
  });
  const invoke = handler("execute_rizin_command");

  const response = (await invoke(
    { path: "package.json", command: "iI" },
    { mcpReq: { signal: new AbortController().signal } },
  )) as { readonly isError?: boolean };

  expect(response.isError).toBe(true);
  expect(recordEvidence).not.toHaveBeenCalled();
});

it("keeps provider execution and Evidence recording inside analysis admission", async () => {
  const { server, handler } = createReverseEngineeringMcpHarness();
  const events: string[] = [];
  const service = new ReverseEngineeringService({
    runOwned: async () => {
      events.push("provider");
      return ownedOutput("objdump output");
    },
  });
  const recordEvidence = vi.fn(() => {
    events.push("record");
    return ok("added" as const);
  });
  const admission: WithAdmittedAnalysis = async (_name, _signal, operation) => {
    events.push("admission-start");
    const result = await operation({} as AnalysisOperationPort);
    events.push("admission-end");
    return ok(result);
  };
  registerReverseEngineeringTools(server, service, {
    recordEvidence,
    withAdmittedAnalysis: admission,
  });
  const invoke = handler("inspect_with_objdump");

  await invoke(
    { path: "package.json", operation: "file_headers" },
    { mcpReq: { signal: new AbortController().signal } },
  );

  expect(events).toEqual([
    "admission-start",
    "provider",
    "record",
    "admission-end",
  ]);
});

it("returns admission failures without invoking a reverse-engineering provider", async () => {
  const { server, handler } = createReverseEngineeringMcpHarness();
  const inspectWithObjdump = vi.fn();
  const service = {
    inspectWithObjdump,
    executeRizinCommandValidated: vi.fn(),
  } as unknown as ReverseEngineeringService;
  const admission: WithAdmittedAnalysis = async () =>
    err(new AnalysisInputError("inspect_with_objdump"));
  registerReverseEngineeringTools(server, service, {
    withAdmittedAnalysis: admission,
  });
  const invoke = handler("inspect_with_objdump");

  const response = (await invoke(
    { path: "package.json", operation: "file_headers" },
    { mcpReq: { signal: new AbortController().signal } },
  )) as { readonly isError?: boolean };

  expect(response.isError).toBe(true);
  expect(inspectWithObjdump).not.toHaveBeenCalled();
});
