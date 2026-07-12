import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";

import { BinarySession } from "../../src/application/BinarySession.js";
import type {
  AnalysisClient,
  AnalysisOperationPort,
} from "../../src/application/AnalysisProvider.js";
import { HopperRemoteError } from "../../src/domain/errors.js";
import { err, ok } from "../../src/domain/result.js";
import { createServer } from "../../src/server/createServer.js";

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
      artifact: null,
      operation: "list_procedures",
      provider: { id: "hopper", version: null },
      result: {
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
      result: "pseudo for 0x1000",
    });

    const xrefResult = await client.callTool({
      name: "xrefs",
      arguments: {},
    });
    expect(structured(xrefResult)).toMatchObject({
      operation: "xrefs",
      result: ["0x1000"],
    });
  });

  it("preserves the complete 46-tool inventory with a session", async () => {
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
    expect(listed.tools).toHaveLength(46);
    const names = listed.tools.map((t) => t.name);
    expect(names).toContain("open_binary");
    expect(names).toContain("close_binary");
    expect(names).toContain("binary_session");
    expect(names).toContain("binary_overview");
    expect(names).toContain("batch_decompile");
  });

  it("preserves the 43-tool inventory without a session", async () => {
    const client = await connect({
      execute: () => Promise.resolve(ok(null)),
    });
    const listed = await client.listTools();
    expect(listed.tools).toHaveLength(43);
    const names = listed.tools.map((t) => t.name);
    expect(names).toContain("binary_overview");
    expect(names).toContain("batch_decompile");
    expect(names).not.toContain("open_binary");
  });

  it("propagates remote Hopper errors with structured content", async () => {
    const client = await connect({
      execute: () =>
        Promise.resolve(err(new HopperRemoteError(-32000, "bridge timeout"))),
    });

    const result = await client.callTool({
      name: "list_documents",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("HopperRemoteError");
    expect(text(result)).toContain("bridge timeout");
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
