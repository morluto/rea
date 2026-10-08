import { constants as bufferConstants } from "node:buffer";

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";

import { ProcessCaptureError } from "../../../src/process/capture/ProcessCaptureError.js";
import { resolveProcessResult } from "../../../src/process/capture/ProcessCaptureLifecycle.js";
import {
  toolContract,
  type ToolContract,
} from "../../../src/contracts/toolContracts.js";
import { err, ok } from "../../../src/domain/result.js";
import { HopperProcessError } from "../../../src/domain/hopperErrors.js";
import type { IncompleteProcessCaptureObservations } from "../../../src/domain/process/processCapture.js";
import { processScenarioSchema } from "../../../src/domain/process/processScenario.js";
import { toCallToolResult } from "../../../src/server/toolResult.js";
import { createEvidence, parseEvidence } from "../../../src/domain/evidence.js";
import { emptyProcessCapture } from "../../../src/domain/process/processCapture.fixture.js";
import type { JsonValue } from "../../../src/domain/jsonValue.js";
import { evidenceResultOf } from "../../../src/contracts/toolOutputSchemas.js";
import { toolRegistrationOptions } from "../../../src/server/toolRegistrationOptions.js";

const contract: ToolContract = {
  name: "provider_neutral_fixture",
  title: "Provider Neutral Fixture",
  description: "Fixture contract for provider-neutral output validation.",
  kind: "enhanced",
  inputSchema: z.object({}),
  outputSchema: z.object({ value: z.string() }),
  effects: {
    mutatesTarget: false,
    mutatesSession: false,
    writesFilesystem: false,
    launchesProcess: false,
    accessesNetwork: false,
    changesUiState: false,
    mayDiscardData: false,
    idempotent: true,
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  examples: [{ title: "Example fixture request", input: {} }],
};

describe("completed partial process capture MCP projection", () => {
  it("preserves partial capture details over the MCP SDK transport", async () => {
    const executionFailure = new Error("capture ended after a fixture error");
    const cleanup = {
      owned_process_group: {
        state: "unverified" as const,
        reason: "process ownership token could not be read",
      },
      terminal_renderer: { state: "cleaned" as const, reason: null },
      temporary_root: { state: "cleaned" as const, reason: null },
    };
    const capture = {
      ...emptyProcessCapture(),
      frames: [{ sequence: 0, at_ms: 0, data: "observed output" }],
      event_journal: [],
    };

    let failure: ProcessCaptureError | undefined;
    try {
      resolveProcessResult(capture, executionFailure, cleanup);
    } catch (cause: unknown) {
      if (!(cause instanceof ProcessCaptureError)) throw cause;
      failure = cause;
    }
    expect(failure).toBeDefined();
    if (failure === undefined)
      throw new Error("expected cleanup-incomplete result");

    const captureContract = toolContract("capture_process_scenario");
    const server = new McpServer({
      name: "process-partial-error",
      version: "1",
    });
    server.registerTool(
      captureContract.name,
      toolRegistrationOptions(captureContract),
      async () => toCallToolResult(err(failure), captureContract),
    );
    const client = new Client({
      name: "process-partial-error-client",
      version: "1",
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool({
        name: captureContract.name,
        arguments: captureContract.examples[0]?.input ?? {},
      });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: "cleanup_incomplete",
          details: {
            cleanup_report: cleanup,
            execution_failure: "capture ended after a fixture error",
            partial_observation: {
              capture: {
                frames: [{ data: "observed output" }],
                settlement: { cleanup_outcome: "failed" },
              },
              execution_failure: "capture ended after a fixture error",
            },
          },
        },
      });
      const textContent = result.content.find((block) => block.type === "text");
      expect(textContent?.type === "text" ? textContent.text : undefined).toBe(
        JSON.stringify(result.structuredContent),
      );
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });
});

describe("incomplete partial process observations MCP projection", () => {
  it("preserves normalized raw observations over the MCP SDK transport", async () => {
    const captureContract = toolContract("capture_process_scenario");
    const example = captureContract.examples[0];
    if (example === undefined)
      throw new Error("missing process scenario example");
    const scenario = processScenarioSchema.parse({
      ...example.input,
      normalization: { pids: false },
    });
    const rootPid = 45678;
    const cleanup = {
      owned_process_group: {
        state: "unverified" as const,
        reason: "process ownership token could not be read",
      },
      terminal_renderer: { state: "cleaned" as const, reason: null },
      temporary_root: { state: "cleaned" as const, reason: null },
    };
    const observations: IncompleteProcessCaptureObservations = {
      target_pid: { state: "available", value: rootPid },
      frames: {
        state: "available",
        value: [{ sequence: 0, at_ms: 0, data: "partial output" }],
      },
      rendered_frames: {
        state: "unavailable",
        reason: "fixture renderer observation unavailable",
      },
      interaction_events: { state: "available", value: [] },
      exit: {
        state: "unavailable",
        reason: "fixture terminal exit unavailable",
      },
      settlement: {
        state: "unavailable",
        reason: "fixture process settlement unavailable",
      },
      process_samples: {
        state: "available",
        value: [
          {
            at_ms: 1,
            pid: rootPid,
            parent_pid: 1,
            command: `fixture ${String(rootPid)}`,
            process_group_id: rootPid,
            session_id: rootPid,
          },
        ],
      },
      filesystem_snapshots: {
        before: { state: "available", value: { files: [], truncated: false } },
        after: {
          state: "unavailable",
          reason: "fixture final snapshot unavailable",
        },
      },
      event_journal: { state: "available", value: [] },
      manifest: {
        state: "unavailable",
        reason: "fixture capture manifest unavailable",
      },
    };

    let failure: ProcessCaptureError | undefined;
    try {
      resolveProcessResult(
        undefined,
        new Error("capture failed before completion"),
        cleanup,
        observations,
        { scenario, rootPid },
      );
    } catch (cause: unknown) {
      if (!(cause instanceof ProcessCaptureError)) throw cause;
      failure = cause;
    }
    if (failure === undefined)
      throw new Error("expected cleanup-incomplete result");

    const server = new McpServer({
      name: "process-partial-observations",
      version: "1",
    });
    server.registerTool(
      captureContract.name,
      toolRegistrationOptions(captureContract),
      async () => toCallToolResult(err(failure), captureContract),
    );
    const client = new Client({
      name: "process-partial-observations-client",
      version: "1",
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool({
        name: captureContract.name,
        arguments: example.input,
      });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          details: {
            partial_observation: {
              observations: {
                target_pid: { state: "available", value: rootPid },
                frames: {
                  state: "available",
                  value: [{ data: "partial output" }],
                },
                process_samples: {
                  state: "available",
                  value: [{ pid: rootPid }],
                },
              },
            },
          },
        },
      });
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });
});

describe("tool result projection", () => {
  it("exposes an actionable adapter code to MCP callers", () => {
    const result = toCallToolResult(err(new HopperProcessError(76)), contract);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: "provider_unavailable",
        details: { failure_code: "unsupported_demo_dialog" },
        category: "unavailable",
      },
    });
  });
  it("projects bounded private-display coordinates without raw stderr", () => {
    const result = toCallToolResult(
      err(
        new HopperProcessError(80, {
          component: "hopper_private_display",
          operation: "launch",
          status: "error",
          failure_code: "x11_socket_directory_unusable",
          reason: "socket_directory_read_only",
          socket_directory: "/tmp/.X11-unix",
          socket_directory_mode: "0777",
          mount_read_only: true,
          effective_socket_directory_mode: "1777",
          effective_mount_read_only: false,
          wsl: true,
          strategy: "user-mount-namespace",
          fallback_reason: null,
          xvfb_stderr_bytes: 512,
        }),
      ),
      contract,
    );
    expect(result.structuredContent).toMatchObject({
      error: {
        details: {
          failure_code: "x11_socket_directory_unusable",
          diagnostics: {
            socket_directory: "/tmp/.X11-unix",
            mount_read_only: true,
            wsl: true,
            strategy: "user-mount-namespace",
          },
        },
      },
    });
  });
  it("returns result and complete Evidence context in one call", () => {
    const evidence = createEvidence(
      undefined,
      { id: "fixture", name: "Fixture", version: "1" },
      {
        operation: "fixture",
        parameters: {},
        result: { value: "observed" },
      },
    );
    const evidenceContract: ToolContract = {
      ...contract,
      outputSchema: evidenceResultOf(z.object({ value: z.string() })),
    };

    const result = toCallToolResult(ok(evidence), evidenceContract);
    expect(result.structuredContent).toMatchObject({
      result: { value: "observed" },
      evidence_id: evidence.evidence_id,
      evidence: {
        normalized_result: { value: "observed" },
        provider: { id: "fixture", name: "Fixture", version: "1" },
        operation: "fixture",
        predicate_type: "rea.analysis",
        parameters: {},
        raw_result: null,
        confidence: "observed",
        authority: "shipped-artifact",
        environment: null,
        limitations: evidence.limitations,
        locations: [],
        evidence_links: [],
      },
    });
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining('"value":"observed"'),
    });
    const parsed = evidenceContract.outputSchema.parse(
      result.structuredContent,
    );
    expect(parseEvidence(parsed.evidence)).toEqual(evidence);
  });

  it.each<JsonValue>([null, false, 0, "", [], { nested: [false, null, 7] }])(
    "preserves a complete reusable Evidence record for JSON result %j",
    (value) => {
      const evidence = createEvidence(
        undefined,
        { id: "fixture", name: "Fixture", version: "1" },
        { operation: "fixture", parameters: {}, result: value },
      );
      const evidenceContract = {
        ...contract,
        outputSchema: evidenceResultOf(z.json()),
      };
      const result = toCallToolResult(ok(evidence), evidenceContract);
      const parsed = evidenceContract.outputSchema.parse(
        result.structuredContent,
      );
      expect(parsed.result).toEqual(value);
      expect(parseEvidence(parsed.evidence)).toEqual(evidence);
      expect(result.content).toEqual([
        { type: "text", text: JSON.stringify(parsed) },
      ]);
      const { normalized_result: _missingResult, ...incomplete } = evidence;
      expect(
        evidenceContract.outputSchema.safeParse({
          ...parsed,
          evidence: incomplete,
        }).success,
      ).toBe(false);
    },
  );
});

describe("tool result transport limits", () => {
  it("returns a typed transport constraint when the serialized envelope cannot fit one message", () => {
    // The Evidence envelope repeats the payload as result and
    // evidence.normalized_result, so the candidate serializes near half the
    // ceiling; its escaped text plus structuredContent pair cannot fit.
    const payload = "x".repeat(
      Math.ceil(bufferConstants.MAX_STRING_LENGTH / 4) + 8192,
    );
    const evidence = createEvidence(
      undefined,
      { id: "fixture", name: "Fixture", version: "1" },
      { operation: "fixture", parameters: {}, result: { payload } },
    );
    const evidenceContract: ToolContract = {
      ...contract,
      outputSchema: evidenceResultOf(z.object({ payload: z.string() })),
    };
    const result = toCallToolResult(ok(evidence), evidenceContract);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: "resource_constraint",
        category: "resource_constraint",
        details: {
          operation: evidenceContract.name,
          resource: "transport",
          evidence_id: evidence.evidence_id,
          reported_limits: {
            transport: "json-rpc-message",
            single_string_code_unit_limit: bufferConstants.MAX_STRING_LENGTH,
          },
        },
      },
    });
    const textContent = result.content.find((block) => block.type === "text");
    expect(textContent?.type === "text" ? textContent.text : undefined).toBe(
      JSON.stringify(result.structuredContent),
    );
  });

  it("reports the runtime's string ceiling instead of leaking a serialization exception", () => {
    const evidence = createEvidence(
      undefined,
      { id: "fixture", name: "Fixture", version: "1" },
      { operation: "fixture", parameters: {}, result: { value: "big" } },
    );
    const stringify = vi.spyOn(JSON, "stringify").mockImplementationOnce(() => {
      throw new RangeError("Invalid string length");
    });
    try {
      const result = toCallToolResult(ok(evidence), contract);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: "resource_constraint",
          details: {
            resource: "transport",
            evidence_id: evidence.evidence_id,
            reported_limits: { serialized_code_units: null },
          },
        },
      });
    } finally {
      stringify.mockRestore();
    }
  });
});
