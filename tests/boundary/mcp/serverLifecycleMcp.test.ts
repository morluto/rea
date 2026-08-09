import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { afterEach, expect, it } from "vitest";

import type { AnalysisOperationPort } from "../../../src/application/AnalysisProvider.js";
import { HopperRemoteError } from "../../../src/domain/errors.js";
import { err } from "../../../src/domain/result.js";
import { observed as ok } from "../../fixtures/analysisExecution.js";
import { createServer } from "../../../src/server/createServer.js";
import {
  SESSION_TOOL_CONTRACTS,
  TOOL_CONTRACTS,
} from "../../../src/contracts/toolContracts.js";
import { MANAGED_WORKFLOW_TOOL_CONTRACTS } from "../../../src/contracts/managedWorkflowToolContracts.js";

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

it("preserves the target-open tool inventory without a session", async () => {
  const client = await connect({
    execute: () => Promise.resolve(ok(null)),
  });
  const listed = await client.listTools();
  expect(listed.tools).toHaveLength(
    TOOL_CONTRACTS.length -
      SESSION_TOOL_CONTRACTS.length -
      MANAGED_WORKFLOW_TOOL_CONTRACTS.length,
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
  expect(text(result)).toBe(JSON.stringify(result.structuredContent));
});

it("lets the SDK validate a tool call before invoking its handler", async () => {
  let invocations = 0;
  const client = await connect({
    execute: () => {
      invocations += 1;
      return Promise.resolve(ok([]));
    },
  });

  const malformed = await client.callTool({
    name: "procedure_info",
    arguments: {},
  });

  expect(malformed.isError).toBe(true);
  expect(invocations).toBe(0);

  const valid = await client.callTool({
    name: "list_documents",
    arguments: {},
  });
  expect(valid.isError).not.toBe(true);
  expect(invocations).toBe(1);
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
