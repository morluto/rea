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
import { createToolResultDelivery } from "./toolResult.js";

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
      ).rejects.toThrow(/cursor/i);
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
      await expect(client.listTools({ cursor })).rejects.toThrow(
        /catalog changed|restart/i,
      );
    } finally {
      await close();
    }
  });

  it("lists a single oversized tool instead of failing the page", async () => {
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
        inputSchema: bigInputSchema("oversized", 40, 150),
      },
      async () => ({ content: [{ type: "text", text: "ok" }] }),
    );
    const { client, close } = await connect(server);
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual(["oversized_tool"]);
    } finally {
      await close();
    }
  });
});
