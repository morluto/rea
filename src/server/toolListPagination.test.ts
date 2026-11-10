import { describe, expect, it } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import {
  isJSONRPCResultResponse,
  type JSONRPCMessage,
  type RegisteredTool,
} from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

import { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import {
  DEFAULT_MCP_TOOLS_LIST_PAGE_BUDGET,
  MCP_TOOLS_LIST_PAGE_BUDGET_SETTING,
  type McpToolsListPageBudget,
} from "../config/mcpToolsListPageBudget.js";
import { createToolResultDelivery } from "./toolResult.js";
import { paginateToolsList } from "./toolListPagination.js";

/** FastMCP's default per-event SSE limit, the bound #9093 reports. */
const FASTMCP_SSE_EVENT_LIMIT_BYTES = 1_048_576;

const bigInputSchema = (seed: string, fields = 40, repeats = 3) => {
  const shape: Record<string, z.ZodType> = {};
  for (let i = 0; i < fields; i++) {
    shape[`field_${String(i).padStart(2, "0")}`] = z
      .string()
      .describe(
        `${seed} field ${i} carries a long description so the advertised schema resembles a real REA tool definition with nested documentation text. `.repeat(
          repeats,
        ),
      );
  }
  return z.strictObject(shape);
};

const createCatalogServer = (count: number) => {
  const server = new EvidenceMcpServer(
    { name: "tools-list-pagination-test", version: "1" },
    { capabilities: {} },
    undefined,
    createToolResultDelivery(10 * 1024 * 1024),
  );
  const registered: RegisteredTool[] = [];
  for (let i = 0; i < count; i++) {
    registered.push(
      server.registerTool(
        `pagination_tool_${String(i).padStart(3, "0")}`,
        {
          description: `Pagination test tool ${i}.`,
          inputSchema: bigInputSchema(`tool-${i}`),
        },
        async () => ({ content: [{ type: "text", text: "ok" }] }),
      ),
    );
  }
  return { server, registered };
};

type ToolsListReply = JSONRPCMessage & {
  result: { tools: { name: string }[]; nextCursor?: string };
};

const catalogNames = (count: number, start = 0): string[] =>
  Array.from(
    { length: count },
    (_, index) => `pagination_tool_${String(start + index).padStart(3, "0")}`,
  );

const isToolsListReply = (message: JSONRPCMessage): message is ToolsListReply =>
  isJSONRPCResultResponse(message) &&
  typeof message.result === "object" &&
  message.result !== null &&
  Array.isArray((message.result as { tools?: unknown }).tools);

const connect = async (server: EvidenceMcpServer) => {
  const client = new Client({
    name: "tools-list-pagination-client",
    version: "1",
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const replies: JSONRPCMessage[] = [];
  const serving = serveStdio(() => server, { transport: serverTransport });
  try {
    await client.connect(clientTransport);
    const receive = clientTransport.onmessage;
    clientTransport.onmessage = (message) => {
      replies.push(message);
      receive?.(message);
    };
    return {
      client,
      replies,
      close: async () => {
        await client.close();
        await serving.close();
      },
    };
  } catch (cause) {
    await serving.close();
    throw cause;
  }
};

describe("tools/list pagination", () => {
  it("pages an oversized catalog into sub-limit events and returns the whole catalog", async () => {
    const { server } = createCatalogServer(80);
    const { client, replies, close } = await connect(server);
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual(
        Array.from(
          { length: 80 },
          (_, i) => `pagination_tool_${String(i).padStart(3, "0")}`,
        ),
      );
      const pages = replies.filter(isToolsListReply);
      expect(pages.length).toBeGreaterThan(1);
      for (const page of pages) {
        expect(Buffer.byteLength(JSON.stringify(page), "utf8")).toBeLessThan(
          FASTMCP_SSE_EVENT_LIMIT_BYTES,
        );
      }
      expect(typeof pages[0]?.result.nextCursor).toBe("string");
      expect(pages.at(-1)?.result.nextCursor).toBeUndefined();
      expect(
        pages.flatMap((page) => page.result.tools.map((tool) => tool.name)),
      ).toEqual(listed.tools.map((tool) => tool.name));
    } finally {
      await close();
    }
  });

  it("returns a small catalog in one response without a cursor", async () => {
    const { server } = createCatalogServer(3);
    const { client, replies, close } = await connect(server);
    try {
      const listed = await client.listTools();
      expect(listed.tools).toHaveLength(3);
      const pages = replies.filter(isToolsListReply);
      expect(pages).toHaveLength(1);
      expect(pages[0]?.result.nextCursor).toBeUndefined();
    } finally {
      await close();
    }
  });

  it("rejects an unknown cursor", async () => {
    const { server } = createCatalogServer(80);
    const { client, close } = await connect(server);
    try {
      await expect(
        client.listTools({ cursor: "rea-tools-list:unknown" }),
      ).rejects.toMatchObject({ code: -32602 });
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual(catalogNames(80));
    } finally {
      await close();
    }
  });

  it("rejects a stale cursor after the catalog changes", async () => {
    const { server, registered } = createCatalogServer(80);
    const { client, replies, close } = await connect(server);
    try {
      await client.listTools();
      const firstPage = replies.filter(isToolsListReply)[0];
      const cursor = firstPage?.result.nextCursor;
      expect(typeof cursor).toBe("string");
      registered[0]?.disable();
      await expect(client.listTools({ cursor })).rejects.toMatchObject({
        code: -32602,
      });
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual(
        catalogNames(79, 1),
      );
    } finally {
      await close();
    }
  });

  it("fails a single oversized tool with the page-budget setting", async () => {
    const server = new EvidenceMcpServer(
      { name: "tools-list-pagination-test", version: "1" },
      { capabilities: {} },
      undefined,
      createToolResultDelivery(10 * 1024 * 1024),
    );
    server.registerTool(
      "oversized_tool",
      {
        description: "A single tool whose schema exceeds the page budget.",
        inputSchema: bigInputSchema("oversized", 40, 800),
      },
      async () => ({ content: [{ type: "text", text: "ok" }] }),
    );
    const { client, close } = await connect(server);
    try {
      await expect(client.listTools()).rejects.toMatchObject({
        code: -32000,
        data: {
          code: "resource_constraint",
          details: {
            reported_limits: {
              setting: MCP_TOOLS_LIST_PAGE_BUDGET_SETTING,
              source: "default",
              effective_bytes: DEFAULT_MCP_TOOLS_LIST_PAGE_BUDGET.bytes,
              default_bytes: DEFAULT_MCP_TOOLS_LIST_PAGE_BUDGET.defaultBytes,
              maximum_bytes: DEFAULT_MCP_TOOLS_LIST_PAGE_BUDGET.maximumBytes,
              tool_name: "oversized_tool",
            },
          },
          remediation: {
            action: expect.stringContaining(MCP_TOOLS_LIST_PAGE_BUDGET_SETTING),
          },
        },
      });
    } finally {
      await close();
    }
  });
});

const listedTool = (name: string, field: string) => ({
  name,
  description: `Tool ${name}`,
  inputSchema: {
    type: "object",
    properties: { [field]: { type: "string", description: field } },
  },
});

const toolsListMessage = (tools: readonly unknown[]): JSONRPCMessage => ({
  jsonrpc: "2.0",
  id: 1,
  result: { tools },
});

const pageBudget = (bytes: number): McpToolsListPageBudget => ({
  ...DEFAULT_MCP_TOOLS_LIST_PAGE_BUDGET,
  bytes,
  source: "setting",
});

describe("tools/list cursor identity", () => {
  it("invalidates a cursor when a tool schema changes and the name does not", () => {
    const original = [
      listedTool("same", "alpha-field-with-enough-text"),
      listedTool("other", "beta-field-with-enough-text"),
    ];
    const renamedSchema = [
      listedTool("same", "gamma-field-with-different-text"),
      listedTool("other", "beta-field-with-enough-text"),
    ];
    const whole = toolsListMessage(original);
    const wholeBytes = Buffer.byteLength(JSON.stringify(whole), "utf8");
    const budget = pageBudget(wholeBytes - 1);
    const first = paginateToolsList(whole, undefined, budget);
    expect(isToolsListReply(first)).toBe(true);
    if (!isToolsListReply(first)) return;
    const cursor = first.result.nextCursor;
    expect(typeof cursor).toBe("string");
    const resumed = paginateToolsList(
      toolsListMessage(renamedSchema),
      cursor,
      budget,
    );
    expect(resumed).toMatchObject({
      error: {
        code: -32602,
        message: expect.stringContaining("catalog changed"),
      },
    });
    const same = paginateToolsList(toolsListMessage(original), cursor, budget);
    expect(isToolsListReply(same)).toBe(true);
  });

  it("rejects one tool that exceeds an explicit page budget", () => {
    const tool = listedTool("solo", "x".repeat(200));
    const message = toolsListMessage([tool]);
    const bytes = Buffer.byteLength(JSON.stringify(message), "utf8");
    const refused = paginateToolsList(
      message,
      undefined,
      pageBudget(bytes - 1),
    );
    expect(refused).toMatchObject({
      error: {
        code: -32000,
        data: {
          code: "resource_constraint",
          details: {
            reported_limits: {
              setting: MCP_TOOLS_LIST_PAGE_BUDGET_SETTING,
              source: "setting",
              effective_bytes: bytes - 1,
              tool_name: "solo",
            },
          },
        },
      },
    });
  });
});
