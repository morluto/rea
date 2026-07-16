import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";

import { BinarySession } from "../../src/application/BinarySession.js";
import type {
  AnalysisClient,
  AnalysisOperationPort,
} from "../../src/application/AnalysisProvider.js";
import {
  AnalysisCapabilityUnavailableError,
  HopperRemoteError,
} from "../../src/domain/errors.js";
import { err } from "../../src/domain/result.js";
import { observed as ok } from "../fixtures/analysisExecution.js";
import { createServer } from "../../src/server/createServer.js";
import { createEvidence } from "../../src/domain/evidence.js";
import { processCaptureSchema } from "../../src/domain/processCapture.js";
import { EMPTY_PROCESS_CAPTURE_EXAMPLE } from "../../src/contracts/processCaptureExample.js";
import { jsonValueSchema } from "../../src/domain/jsonValue.js";
import { PROCESS_PROVIDER } from "../../src/server/sessionToolPolicies.js";
import {
  SESSION_TOOL_CONTRACTS,
  TOOL_CONTRACTS,
} from "../../src/contracts/toolContracts.js";

const resources: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(
    resources.splice(0).map(async (resource) => resource.close()),
  );
});

const connect = async (analysis: AnalysisOperationPort) => {
  const server = createServer(analysis);
  const client = new Client({
    name: "integration-test",
    version: "1.0.0",
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  resources.push(client, server);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
};

const text = (result: CallToolResult): string => {
  const content = result.content.find((item) => item.type === "text");
  if (content?.type !== "text") throw new Error("missing text result");
  return content.text;
};

const structured = (result: CallToolResult): Record<string, unknown> => {
  if (
    typeof result.structuredContent !== "object" ||
    result.structuredContent === null
  )
    throw new Error("missing structured result");
  return Object.fromEntries(Object.entries(result.structuredContent));
};

describe("full MCP integration with multi-tool sequences", () => {
  it("executes a realistic workflow: list methods, decompile selected, get xrefs", async () => {
    const client = await connect({
      execute: (name, args) => {
        switch (name) {
          case "list_procedures":
            return Promise.resolve(
              ok({
                items: [
                  { address: "0x1000", value: "main" },
                  { address: "0x2000", value: "helper" },
                ],
                offset: 0,
                limit: 100,
                total: 2,
                next_offset: null,
                has_more: false,
              }),
            );
          case "procedure_pseudo_code":
            return Promise.resolve(
              ok(`pseudo for ${(args as { procedure: string }).procedure}`),
            );
          case "xrefs":
            return Promise.resolve(ok(["0x1000"]));
          default:
            return Promise.resolve(ok(null));
        }
      },
    });

    const listResult = await client.callTool({
      name: "list_procedures",
      arguments: {},
    });
    expect(listResult.isError).not.toBe(true);
    expect(structured(listResult)).toMatchObject({
      subject: null,
      operation: "list_procedures",
      provider: { id: "fixture", version: "1" },
      normalized_result: {
        items: [
          { address: "0x1000", value: "main" },
          { address: "0x2000", value: "helper" },
        ],
        total: 2,
        has_more: false,
      },
    });

    const decompileResult = await client.callTool({
      name: "procedure_pseudo_code",
      arguments: { procedure: "0x1000" },
    });
    expect(structured(decompileResult)).toMatchObject({
      operation: "procedure_pseudo_code",
      parameters: { document: null, procedure: "0x1000" },
      normalized_result: "pseudo for 0x1000",
    });

    const xrefResult = await client.callTool({
      name: "xrefs",
      arguments: {},
    });
    expect(structured(xrefResult)).toMatchObject({
      operation: "xrefs",
      normalized_result: ["0x1000"],
    });
  });

  it("preserves the complete 86-tool inventory with a session", async () => {
    const session = new BinarySession(
      (_path) =>
        ({
          execute: () => Promise.resolve(ok(null)),
          close: () => Promise.resolve(),
        }) satisfies AnalysisClient,
    );
    const server = createServer(
      { execute: () => Promise.resolve(ok(null)) },
      session,
    );
    const client = new Client({
      name: "integration-test",
      version: "1.0.0",
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    resources.push(client, server);
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const listed = await client.listTools();
    expect(listed.tools).toHaveLength(86);
    const names = listed.tools.map((t) => t.name);
    expect(names).toContain("open_binary");
    expect(names).toContain("close_binary");
    expect(names).toContain("binary_session");
    expect(names).toContain("binary_overview");
    expect(names).toContain("batch_decompile");
  });

  it("records approved trace truncation as a deduplicated residual unknown", async () => {
    const analysis: AnalysisOperationPort = {
      execute: () =>
        Promise.resolve(
          ok({
            items: [],
            offset: 0,
            limit: 500,
            total: 0,
            next_offset: null,
            has_more: false,
          }),
        ),
    };
    const session = new BinarySession(
      () =>
        ({
          execute: () => Promise.resolve(ok(null)),
          close: () => Promise.resolve(),
        }) satisfies AnalysisClient,
    );
    const server = createServer(analysis, session);
    const client = new Client({ name: "unknown-workflow", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    resources.push(client, server);
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const traced = await client.callTool({
        name: "trace_feature",
        arguments: {
          query: "license",
          max_operations: 1,
          unknown_registry_approved: true,
        },
      });
      expect(traced.isError).not.toBe(true);
    }
    const listed = structured(
      await client.callTool({ name: "list_unknowns", arguments: {} }),
    );
    expect(listed).toMatchObject({
      result: [
        {
          status: "open",
          domain: "control-flow",
          question: "Investigation reached the operation budget.",
        },
      ],
    });
  });

  it("records approved typed capability unavailability without forwarding the flag", async () => {
    const received: Array<Readonly<Record<string, unknown>>> = [];
    const analysis: AnalysisOperationPort = {
      execute: (name, arguments_) => {
        received.push(arguments_);
        return Promise.resolve(
          err(
            new AnalysisCapabilityUnavailableError(
              "partial",
              name,
              "Decompiler is not installed.",
            ),
          ),
        );
      },
    };
    const session = new BinarySession(
      () =>
        ({
          execute: () => Promise.resolve(ok(null)),
          close: () => Promise.resolve(),
        }) satisfies AnalysisClient,
    );
    const server = createServer(analysis, session);
    const client = new Client({ name: "unavailable-unknown", version: "1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    resources.push(client, server);
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const unavailable = await client.callTool({
      name: "procedure_pseudo_code",
      arguments: {
        procedure: "main",
        unknown_registry_approved: true,
      },
    });
    expect(unavailable.isError).toBe(true);
    expect(structured(unavailable)).toMatchObject({
      error: {
        category: "unsupported_provider",
      },
    });
    expect(received[0]).not.toHaveProperty("unknown_registry_approved");
    expect(
      structured(
        await client.callTool({ name: "list_unknowns", arguments: {} }),
      ),
    ).toMatchObject({
      result: [
        {
          domain: "analysis-capability",
          question:
            "The requested analysis is unavailable for the current target.",
          recommended_probes: [
            {
              rationale:
                "Choose another analysis or target that can answer this question.",
            },
          ],
        },
      ],
    });
  });

  it("records approved capture disagreement as a contradicted unknown", async () => {
    const session = new BinarySession(
      () =>
        ({
          execute: () => Promise.resolve(ok(null)),
          close: () => Promise.resolve(),
        }) satisfies AnalysisClient,
    );
    const left = processCaptureSchema.parse(EMPTY_PROCESS_CAPTURE_EXAMPLE);
    const right = processCaptureSchema.parse({
      ...EMPTY_PROCESS_CAPTURE_EXAMPLE,
      interaction_events: [
        {
          sequence: 0,
          scheduled_at_ms: 0,
          dispatched_at_ms: 0,
          type: "input",
          data: "fixture",
          outcome: "dispatched",
        },
      ],
      shim_events: [
        {
          sequence: 0,
          at_ms: 0,
          command: "fixture",
          route_index: null,
          arguments: [],
          working_directory: "/tmp",
          outcome: "unmatched",
        },
      ],
    });
    const captureEvidence = (capture: typeof left) =>
      createEvidence(undefined, PROCESS_PROVIDER, {
        predicateType: "rea.process-capture/v4",
        operation: "capture_process_scenario",
        parameters: {},
        result: jsonValueSchema.parse(capture),
        confidence: "observed",
        authority: "controlled-replay",
      });
    const leftEvidence = captureEvidence(left);
    const rightEvidence = captureEvidence(right);
    expect(session.recordEvidence(leftEvidence).ok).toBe(true);
    expect(session.recordEvidence(rightEvidence).ok).toBe(true);
    const server = createServer(
      { execute: () => Promise.resolve(ok(null)) },
      session,
    );
    const client = new Client({ name: "comparison-unknown", version: "1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    resources.push(client, server);
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const mismatched = await client.callTool({
      name: "compare_process_captures",
      arguments: {
        left_evidence_id: leftEvidence.evidence_id,
        left: right,
        right_evidence_id: rightEvidence.evidence_id,
        right,
      },
    });
    expect(mismatched.isError).toBe(true);

    const compared = await client.callTool({
      name: "compare_process_captures",
      arguments: {
        left_evidence_id: leftEvidence.evidence_id,
        left,
        right_evidence_id: rightEvidence.evidence_id,
        right,
        unknown_registry_approved: true,
      },
    });
    expect(compared.isError).not.toBe(true);
    expect(
      structured(
        await client.callTool({ name: "list_unknowns", arguments: {} }),
      ),
    ).toMatchObject({
      result: [
        {
          status: "contradicted",
          domain: "process-comparison",
          question: "Process captures disagree across: interaction, shim",
          contradicting_evidence_ids: [rightEvidence.evidence_id],
        },
      ],
    });
  });

  it("preserves the target-open tool inventory without a session", async () => {
    const client = await connect({
      execute: () => Promise.resolve(ok(null)),
    });
    const listed = await client.listTools();
    expect(listed.tools).toHaveLength(
      TOOL_CONTRACTS.length - SESSION_TOOL_CONTRACTS.length,
    );
    const names = listed.tools.map((t) => t.name);
    expect(names).toContain("binary_overview");
    expect(names).toContain("batch_decompile");
    expect(names).not.toContain("open_binary");
  });

  it("projects remote failures without provider or bridge details", async () => {
    const client = await connect({
      execute: () =>
        Promise.resolve(err(new HopperRemoteError(-32000, "bridge timeout"))),
    });

    const result = await client.callTool({
      name: "list_documents",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    expect(structured(result)).toMatchObject({
      error: {
        category: "execution_failure",
      },
    });
    expect(text(result)).toBe(
      "Analysis could not complete. Retry once; if it continues, run `rea doctor`.",
    );
  });

  it("handles concurrent tool calls without corruption", async () => {
    const invocations: string[] = [];
    const client = await connect({
      execute: (name) => {
        invocations.push(name);
        return Promise.resolve(
          ok(
            ["list_procedures", "list_strings"].includes(name)
              ? {
                  items: [],
                  offset: 0,
                  limit: 100,
                  total: 0,
                  next_offset: null,
                  has_more: false,
                }
              : [],
          ),
        );
      },
    });

    const results = await Promise.all([
      client.callTool({ name: "list_procedures", arguments: {} }),
      client.callTool({ name: "list_segments", arguments: {} }),
      client.callTool({ name: "list_strings", arguments: {} }),
    ]);

    expect(results.every((r) => !r.isError)).toBe(true);
    expect(invocations).toHaveLength(3);
    expect(new Set(invocations).size).toBe(3);
  });
});
