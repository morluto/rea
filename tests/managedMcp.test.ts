import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { AnalysisProviderRegistry } from "../src/application/AnalysisProviderRegistry.js";
import { BinarySession } from "../src/application/BinarySession.js";
import { SessionProviderRouter } from "../src/application/SessionProviderRouter.js";
import { ManagedStaticProvider } from "../src/dotnet/ManagedStaticProvider.js";
import { createServer } from "../src/server/createServer.js";
import { buildManagedPeFixture } from "./fixtures/managedPe.js";

describe("managed artifact MCP tools", () => {
  it("opens a managed PE and executes the managed static provider through MCP", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rea-managed-mcp-"));
    const path = join(directory, "fixture.exe");
    await writeFile(path, buildManagedPeFixture());
    const session = new BinarySession(
      SessionProviderRouter.selectable(new AnalysisProviderRegistry([]), [
        new ManagedStaticProvider(),
      ]),
    );
    const server = createServer(session, session);
    const client = new Client({ name: "managed-mcp-test", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const tools = await client.listTools();
      expect(tools.tools.map(({ name }) => name)).toContain(
        "inspect_managed_artifact",
      );

      await client.callTool({
        name: "open_binary",
        arguments: { path },
      });
      const inspected = structured(
        await client.callTool({
          name: "inspect_managed_artifact",
          arguments: { reference_limit: 1 },
        }),
      );

      expect(inspected).toMatchObject({
        operation: "inspect_managed_artifact",
        provider: { id: "rea-dotnet-static" },
        subject: { local_path: path, format: "pe" },
        normalized_result: {
          classification: {
            status: "managed",
            runtime_family: "modern-dotnet",
          },
          references: { limit: 1 },
        },
      });
    } finally {
      await Promise.all([client.close(), server.close()]);
      await session.close();
    }
  }, 30_000);
});

const structured = (result: CallToolResult): Record<string, unknown> => {
  if (
    typeof result.structuredContent !== "object" ||
    result.structuredContent === null
  )
    throw new Error("missing structured result");
  return z.record(z.string(), z.unknown()).parse(result.structuredContent);
};
